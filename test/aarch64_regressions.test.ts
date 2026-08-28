import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Regression tests for aarch64 backend bugs found via the Differator port
// (each ran correctly on C but crashed or corrupted memory on aarch64).

// A struct param that misses the callee-saved register pool (x19..x22) is
// spilled to a local slot holding the POINTER to the caller's struct. Every
// consumer must load the pointer — taking the slot's address is a double
// indirection that forwarded garbage (histogram's 9-param find_anchor chain
// SIGSEGV'd reading a bogus List length).
test("spilled struct param forwarding", async () => {
	const input = `
func len_of = (List<int> xs, out int) {
  return xs.length
}

func spill = (List<int> a, List<int> b, List<int> c, List<int> d, List<int> e, out int) {
  return len_of(a) + len_of(b) + len_of(c) + len_of(d) + len_of(e)
}

var List<int> la = List<int>()
la.push(1)
var List<int> lb = List<int>()
lb.push(1)
lb.push(2)
var List<int> lc = List<int>()
lc.push(1)
lc.push(2)
lc.push(3)
var List<int> ld = List<int>()
ld.push(1)
ld.push(2)
ld.push(3)
ld.push(4)
var List<int> le = List<int>()
le.push(1)
le.push(2)
le.push(3)
le.push(4)
le.push(5)
Console.write("\\{spill(la, lb, lc, ld, le)}")
`;
	await build_and_check_output(input, "spilled_struct_param_forward", "15");
});

// A value-struct declaration initialized from a non-`mov` field access —
// including the checker-hoisted `_param_N` temp for a struct call argument —
// is a shallow borrow whose buffer belongs to the owner. Destroying it at
// scope exit freed the owner's data (render_text's `diff.changes` arg led to
// a double-free abort once the diff list was destroyed).
test("field struct borrow not destroyed", async () => {
	const input = `
pub class Holder {
  mov List<int> items = List<int>()
}

func count = (List<int> xs, out int) {
  return xs.length
}

var Holder h = Holder()
h.items.push(1)
h.items.push(2)
h.items.push(3)
const int n = count(h.items)
h.items.push(4)
Console.write("\\{n} \\{h.items.length}")
`;
	await build_and_check_output(input, "field_struct_borrow_kept", "3 4");
});

// An inlined function body's returns run the heap-slot cleanup, which must
// only free anchors the INLINE BODY created — walking the outer function's
// cleanup stack freed its live class instances (find_anchor's inlined
// abs_int aborted with POINTER_BEING_FREED_WAS_NOT_ALLOCATED).
test("inline body does not free outer anchors", async () => {
	const input = `
pub class Thing {
  var v = 0
}

func sign = (int x, out int) {
  if x < 0 {
    return 0 - x
  }
  return x
}

var Thing a = Thing()
var Thing b = Thing()
const int r = sign(-7)
a.v = r
b.v = r + 1
const int r2 = sign(9)
Console.write("\\{a.v} \\{b.v} \\{r2}")
`;
	await build_and_check_output(input, "inline_outer_anchors_kept", "7 8 9");
});

// A class-typed declaration initialized from a NON-owning method call
// (`diffs.at(i)`) is a borrow — the container owns the element. The scope-exit
// auto-destroy wrongly destroyed (and zeroed) the borrowed instance's fields,
// so a later `.at` on the same element crashed on a nulled buffer.
test("class borrow from at() not destroyed", async () => {
	const input = `
import System

pub class Box {
  var List<int> items = List<int>()
}

func first_of = (List<int> xs, int i, out int) {
  if i >= 0 && i < xs.length {
    return xs.at(i)
  }
  return 0
}

func box_at = (List<Box> xs, int i, out Box) {
  var int j = i
  if j >= 0 && j < xs.length {
    var Box got = xs.at(j)
    return mov got
  }
  var empty = Box()
  return mov empty
}

pub func main = () {
  var List<Box> boxes = List<Box>()
  var Box first = Box()
  first.items.push(10)
  var Box second = Box()
  second.items.push(20)
  boxes.push(mov first)
  boxes.push(mov second)

  var int total = 0
  const Box taken = box_at(boxes, 1)
  total += first_of(taken.items, 0)
  const Box again = box_at(boxes, 1)
  total += first_of(again.items, 0)
  const Box also_first = box_at(boxes, 0)
  total += first_of(also_first.items, 0)
  Console.write("\\{total}")
  Console.write("\\{boxes.length}")
}
`;
	await build_and_check_output(input, "class_at_borrow_kept", "502", true);
});

// A bool local promoted into a callee-saved register across calls was
// loaded with a full-width `ldr` from its 1-byte `strb` slot — dirty stack
// bytes above the slot made the register cache read `true` regardless of
// the stored value, so `while ... && !done` never executed its body (the
// writeback likewise `str`-ed 8 bytes into the 1-byte slot, corrupting a
// neighbor). The cache load/store must use the slot's width (ldrb/strb).
test("bool promoted across calls reads stored byte", async () => {
	const input = `
func pad = (int a, out int) {
  var x1 = a + 1
  var x2 = a + 2
  var x3 = a + 3
  return x1 + x2 + x3
}

var total = 0
var k = 0
while k < 5 {
  total += pad(k)
  k += 1
}
var Map<string, int> m = Map<string, int>()
m.set("x", 42)
var idx = m.get_or("x", -1)
var done = false
var n = 0
while idx != -1 && !done && !done {
  n += 1
  done = true
}
Console.write("idx=\\{idx} n=\\{n}")
`;
	await build_and_check_output(input, "bool_promoted_byte_load", "idx=42 n=1");
});

// Whole-function register allocation (phase 4): a scalar local read ≥4 times
// across the function is promoted into a callee-saved register at its
// declaration (initialized in the register, no loop load/store brackets) and
// must survive calls (callee-saved), reassignment, and sub-word widths.
test("whole-function promoted int survives calls and reassignment", async () => {
	const input = `
func step = (int v, out int) {
  return v + 1
}

var acc = 0
var guard = 0
while guard < 10 {
  acc = step(acc) + acc
  guard = guard + 1
}
Console.write("acc=\\{acc}")
`;
	// acc doubles + 1 each iteration: 2^10 - 1.
	await build_and_check_output(input, "wholefunc_promoted_int", "acc=1023");
});

// A ref-passed variable must NOT be whole-function promoted (the callee
// writes through &slot; a register copy would go stale), while a hot sibling
// local still promotes.
test("ref-passed local excluded from whole-function promotion", async () => {
	const input = `
func bump = (ref int acc) {
  acc = acc + 1
}

var total = 0
var k = 0
while k < 5 {
  total = total + k
  k = k + 1
}
bump(ref total)
bump(ref total)
bump(ref total)
bump(ref total)
Console.write("total=\\{total}")
`;
	// 0+0+1+2+3+4 = 10, then four bumps → 14.
	await build_and_check_output(input, "wholefunc_ref_excluded", "total=14");
});

// A name shadowed by a second declaration anywhere in the function must not
// be whole-function promoted (the two instances would share one register).
test("shadowed name excluded from whole-function promotion", async () => {
	const input = `
var x = 1
var i = 0
while i < 3 {
  x = x * 2
  i = i + 1
}
var out = 0
if x > 4 {
  var x = 100
  x = x + 1
  out = x
}
Console.write("out=\\{out}")
`;
	await build_and_check_output(input, "wholefunc_shadow_excluded", "out=101");
});

// A variable shadowed inside an if-branch must not corrupt the OUTER variable:
// the branch's declaration gets its own stack slot, and after the branch the
// outer name resolves back to the outer slot. (stack_offsets used to be a flat
// name-keyed map — the inner declaration clobbered the outer entry, so reads
// after the branch saw the inner slot; the C backend always scoped correctly.)
test("shadowed local read after its scope", async () => {
	const input = `
var x = 1
var i = 0
while i < 3 { x = x * 2  i = i + 1 }
if x > 4 {
  var x = 100
  x = x + 1
  Console.write("inner=\\{x}")
}
Console.write("x=\\{x}")
`;
	await build_and_check_output(input, "shadowed_local_read_after_scope", "inner=101x=8");
});

// A whole-function promoted float lives in a callee-saved d-register for the
// entire function; its literal initializer must initialize the register.
test("whole-function promoted float initializes in register", async () => {
	const input = `
var float f = 1.0
var i = 0
while i < 8 {
  f = f * 1.5 + f * 0.5
  i = i + 1
}
Console.write("f=\\{f}")
`;
	// f doubles each iteration: 2^8 = 256.
	await build_and_check_output(input, "wholefunc_promoted_float", "f=256");
});

// Whole-function register allocation (phase 4, params tranche): a hot scalar
// PARAM initializes its callee-saved register in the prologue (mov/fmov from
// the incoming param register instead of a slot spill) and must survive real
// calls (callee-saved) inside loops.
test("whole-function promoted int param survives calls and reassignment", async () => {
	const input = `
func id = (int x, out int) {
  return x
}

func peek = (int v, out int) {
  return id(v) * 2
}

func spin = (int n, out int) {
  var i = 0
  var t = n * 2
  while i < 10 {
    t = peek(t) - t / 2 + t
    i = i + 1
  }
  return t + n + n + n + n
}

Console.write("n=\\{spin(3)}")
`;
	// t' = 3t - floor(t/2) from 6: 15, 38, 95, 238, 595, 1488, 3720, 9300,
	// 23250, 58125. Return 58125 + 12 = 58137. (`peek` contains a call, so it
	// is NOT inlined — n/x23 must survive the real bl each iteration.)
	await build_and_check_output(input, "wholefunc_promoted_int_param", "n=58137");
});

// A hot float param is promoted into a callee-saved d-register; the incoming
// raw bits ride an x param register, so the prologue init is an fmov.
test("whole-function promoted float param initializes via fmov", async () => {
	const input = `
func scale = (float a, float b, out float) {
  var i = 0
  var float acc = 0.0
  while i < 8 {
    acc = acc + a * b - a + a * b - a
    i = i + 1
  }
  return acc + a + b
}

Console.write("r=\\{scale(2.0, 0.5)}")
`;
	// per iter: (a*b - a) * 2 = (1.0 - 2.0) * 2 = -2.0 → acc = -16;
	// -16 + 2.0 + 0.5 = -13.5.
	await build_and_check_output(input, "wholefunc_promoted_float_param", "r=-13.5");
});

// A sub-word (bool) promoted param keeps its spill but adds a width-aware
// load (ldrb), so the register holds exactly the zero-extended byte a slot
// read would produce — full-width compares on the register see clean bits.
test("whole-function promoted bool param reads correct byte", async () => {
	const input = `
func flagtest = (bool flag, out int) {
  var n = 0
  if flag {
    n = n + 2
  } else {
    n = n + 1
  }
  if flag {
    n = n + 2
  } else {
    n = n + 1
  }
  if flag {
    n = n + 2
  } else {
    n = n + 1
  }
  if flag {
    n = n + 2
  } else {
    n = n + 1
  }
  return n
}

Console.write("\\{flagtest(false)} \\{flagtest(true)}")
`;
	// false → +1 each = 4; true → +2 each = 8.
	await build_and_check_output(input, "wholefunc_promoted_bool_param", "4 8");
});

// A hot param promotes while a hot sibling LOCAL that is ref-passed must NOT
// (the callee writes through &slot; a register copy would go stale).
test("ref-passed local excluded beside promoted param", async () => {
	const input = `
func bump = (ref int acc) {
  acc = acc + 1
}

func mix = (int hot, out int) {
  var i = 0
  var t = 0
  var shared = 10
  while i < 5 {
    t = t + hot + hot + hot + hot
    i = i + 1
  }
  bump(ref shared)
  bump(ref shared)
  return t * 100 + shared
}

Console.write("r=\\{mix(3)}")
`;
	// t = 5 * 12 = 60; shared 10 → 12; 60*100 + 12 = 6012.
	await build_and_check_output(input, "wholefunc_param_ref_excluded", "r=6012");
});

// A param whose name is redeclared as a local anywhere in the function must
// not be promoted (the register would be shared by two variables).
test("param shadowed by local excluded from whole-function promotion", async () => {
	const input = `
func shady = (int v, out int) {
  var t = v + v + v + v
  if t > 4 {
    var v = 100
    t = t + v
  }
  return t
}

Console.write("r=\\{shady(2)}")
`;
	// t = 8; 8 > 4 → inner v = 100, t = 108.
	await build_and_check_output(input, "wholefunc_param_shadow_excluded", "r=108");
});

// A promoted param past the 8 register-arg boundary arrives in the caller's
// outgoing stack area; the prologue init must load it straight into the
// promoted register via the overflow placeholder.
test("overflow param promoted into callee-saved register", async () => {
	const input = `
func wide = (int a, int b, int c, int d, int e, int f, int g, int h, int hot, out int) {
  var i = 0
  var t = 0
  while i < 4 {
    t = t + hot + hot + hot + hot
    i = i + 1
  }
  return t + a + b + c + d + e + f + g + h
}

Console.write("r=\\{wide(1, 2, 3, 4, 5, 6, 7, 8, 10)}")
`;
	// t = 4 * 40 = 160; + 36 = 196.
	await build_and_check_output(input, "wholefunc_overflow_param", "r=196");
});

// An inlined method's param sharing a name with the caller's promoted local
// must read ITS OWN value, not the caller's register or slot: the inline
// body previously saw the caller's register_allocations, and the
// float-operand fast path also probed the caller's stack_offsets before the
// inline param's register — so the body's `n` grabbed the caller's copy.
test("inline body param does not alias caller's promoted register", async () => {
	const input = `
struct F {
  inline func twice = (float n, out float) {
    return n + n
  }
}

var F f = F()
var float n = 2.0
var float r1 = f.twice(1.5) + n
var float r2 = f.twice(n) * n
var float r3 = f.twice(0.25) + n
var float r4 = f.twice(4.0) * n
Console.write("\\{r1} \\{r2} \\{r3} \\{r4} \\{n}")
`;
	// 3+2=5, 4*2=8, 0.5+2=2.5, 8*2=16, n stays 2 (multi-arg interpolation
	// formats floats with %f).
	await build_and_check_output(
		input,
		"inline_param_no_alias_promoted_reg",
		"5.000000 8.000000 2.500000 16.000000 2.000000",
	);
});

// An int16/uint16 param spills into a 2-byte slot; the store must be `strh`
// (the old code fell through to a full-width `str`, writing 8 bytes into the
// 2-byte slot). Same for a custom #init's sub-word params (that path used a
// full-width `str` for EVERY sub-word size, including bool).
test("int16 params spill with halfword stores", async () => {
	const input = `
func narrow = (int16 a, int16 b, out int16) {
  return a + b + a + b
}

struct S {
  var uint16 s
  var bool f
  pub func #init = (self, uint16 s, bool f) {
    self.s = s
    self.f = f
  }
  pub func parts = (self, out int) {
    if self.f {
      return (self.s as int) + 1
    }
    return self.s as int
  }
}

var int16 one = 1000
var int16 two = 2000
var uint16 big = 50000
var S x = S(one as uint16, true)
var S y = S(big, false)
Console.write("\\{narrow(one, two) as int} \\{x.parts()} \\{y.parts()}")
`;
	// narrow: 2*(1000+2000) = 6000; x: 1000+1 = 1001; y: 50000 stores and
	// reloads through its 2-byte slot intact.
	await build_and_check_output(input, "int16_param_halfword_spill", "6000 1001 50000");
});

// A struct declared INSIDE a function with whole-function promotions: the
// method body must build with the enclosing's promotion maps cleared (a
// same-named method local previously aliased the enclosing's register), and
// the enclosing's claimed-register set must survive the method build (it was
// cleared, dropping the enclosing's prologue saves — clobbering the CALLER's
// promoted register across the bl).
test("nested struct method under enclosing promotions", async () => {
	const input = `
func outer = (int a, out int) {
  struct P {
    var int x
    pub func read = (self, out int) {
      var t = 4
      var i = 0
      while i < 3 {
        t = t + 1
        i = i + 1
      }
      return self.x + t + t
    }
  }
  var P p = P(7)
  var t = a * 2
  var n = 0
  var j = 0
  while j < 4 {
    n = n + p.read() + t + t + t
    j = j + 1
  }
  return t + n
}

var m = 3
var r = outer(m + m + m + m)
Console.write("m=\\{m} r=\\{r}")
`;
	// outer(12): t=24 (promoted in outer); P.read: t=7 (its OWN t, not
	// outer's 24), returns 7+7+7=21; n = 4*(21+72) = 372; return 24+372=396.
	// main's m (5 reads, whole-function promoted) must survive the bl outer.
	await build_and_check_output(input, "nested_struct_under_promotions", "m=3 r=396");
});

// A plain `func` nested inside another function body is an inline candidate
// (the scan used to only visit root statements, so the test harness — which
// wraps everything in main — never inlined user helpers). The checker
// rejects closures, so a nested body is safe to inline anywhere.
test("nested function statement is inlined at call sites", async () => {
	const input = `
func step = (int x, out int) {
  return x + x + 1
}

var t = 0
var i = 0
while i < 5 {
  t = t + step(i)
  i = i + 1
}
Console.write("t=\\{t}")
`;
	// step(i) = 2i+1 summed over 0..4 = 2*10 + 5 = 25.
	await build_and_check_output(input, "nested_func_inlined", "t=25");
});

// Two siblings may each declare a same-named nested func: call resolution is
// parent-scoped during checking, but both backends hoist nested funcs to file
// scope — previously BOTH emitted the flat bare label (duplicate symbol,
// assembler/linker error). Each now emits under `<parent>_<name>`.
test("sibling nested functions share a name without colliding", async () => {
	const input = `
func one = (int x, out int) {
  func helper = (int a, out int) {
    return a * 2
  }
  return helper(x)
}

func two = (int x, out int) {
  func helper = (int a, out int) {
    return a * 3
  }
  return helper(x)
}

Console.write("\\{one(5)} \\{two(5)}")
`;
	// Each parent's helper resolves to its OWN body: 5*2=10, 5*3=15.
	await build_and_check_output(input, "sibling_nested_funcs_unique_labels", "10 15");
});

// Monomorphized clones of a generic parent duplicate the parent's body —
// including its nested funcs. Previously every instantiation emitted the
// same flat `pick:` label (duplicate symbol); each clone now gets its own.
test("generic parent's nested func is uniquified per instantiation", async () => {
	const input = `
struct Box<T> {
  var T value
}

func pickin<T> = (Box<T> a, Box<T> b, out int) {
  func pick = (int x, int y, out int) {
    if x != y {
      return x
    }
    return y
  }
  return pick(1, 2) + pick(2, 3)
}

var Box<int> p = Box<int>(3)
var Box<int> q = Box<int>(4)
var Box<string> r = Box<string>("x")
var Box<string> w = Box<string>("y")
Console.write("\\{pickin(p, q)} \\{pickin(r, w)}")
`;
	// pick(1,2)=1, pick(2,3)=2 → 3 per instantiation.
	await build_and_check_output(input, "mono_clone_nested_func_labels", "3 3");
});
