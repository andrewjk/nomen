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
