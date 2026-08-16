import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("memory double free", () => {
	test("assigning heap string to another does not double-free", async () => {
		const input = `
var int x = 1
var int y = 2
var string s = x.to_string()
var string t = y.to_string()
t = s
Console.write(s)
Console.write(t)
`;
		await build_and_check_output(input, "dfree_assign_heap_string", "11");
	});

	test("returning heap string is not use-after-free", async () => {
		const input = `
func make_greeting = (int x, out string) {
  var string s = x.to_string()
  return s
}
var string result = make_greeting(42)
Console.write(result)
`;
		await build_and_check_output(input, "dfree_return_heap_string", "42");
	});

	test("reassigning heap string to literal does not free non-heap pointer", async () => {
		const input = `
var int x = 42
var string s = x.to_string()
s = "literal"
Console.write(s)
`;
		await build_and_check_output(input, "dfree_reassign_to_literal", "literal");
	});

	test("reassigning heap string frees old value", async () => {
		const input = `
var int a = 1
var int b = 2
var string s = a.to_string()
s = b.to_string()
Console.write(s)
`;
		await build_and_check_output(input, "dfree_reassign_leaks_old", "2");
	});

	test("returning string from nested scope does not leak", async () => {
		const input = `
func greet = (int x, out string) {
  var string s = x.to_string()
  if x == 42 {
    return s
  }
  return s
}
var string result = greet(42)
Console.write(result)
`;
		await build_and_check_output(input, "dfree_return_nested_scope", "42");
	});

	test("struct with string field does not leak on destroy", async () => {
		const input = `
struct Named {
  var int id
  var string name
}

var int id = 1
var string name = 42.to_string()
var Named n = Named(id, name)
Console.write("\\{n.id}")
`;
		await build_and_check_output(input, "dfree_struct_string_field", "1");
	});

	test("break does not leak heap string in loop body", async () => {
		const input = `
var int i = 0
while i < 3 {
  var string s = i.to_string()
  if i == 1 {
    i += 1
    break
  }
  Console.write(s)
  i += 1
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_break_heap_string", "0done");
	});

	test("continue does not leak heap string in loop body", async () => {
		const input = `
var int i = 0
while i < 3 {
  var string s = i.to_string()
  i += 1
  if i == 2 {
    continue
  }
  Console.write(s)
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_continue_heap_string", "02done");
	});

	test("aliasing heap string via declaration then reassigning original is not UAF", async () => {
		const input = `
var string a = 42.to_string()
var string b = a
a = "literal"
Console.write(b)
`;
		await build_and_check_output(input, "uaf_alias_then_reassign", "42");
	});

	test("assigning heap string to another variable does not leak old value", async () => {
		const input = `
var string s = 42.to_string()
var string t = s
Console.write(t)
`;
		await build_and_check_output(input, "leak_alias_declaration", "42");
	});

	test("while loop break does not leak heap string", async () => {
		const input = `
var int i = 0
while i < 3 {
  var string s = i.to_string()
  i += 1
  if i == 2 {
    break
  }
  Console.write(s)
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_while_break", "0done");
	});

	test("break runs struct destroy in loop", async () => {
		const input = `
struct Resource {
  var int handle

  func #destroy = (ref self) {
    self.handle = -1
  }
}

var int i = 0
while i < 3 {
  var Resource r = Resource(i)
  if i == 1 {
    i += 1
    break
  }
  i += 1
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		expect(result.code).toContain("bl Resource_destroy");
		expect(result.code.match(/bl Resource_destroy/g)?.length).toBe(2);
		await build_and_check_output(input, "leak_break_struct_destroy", "done");
	});

	test("continue runs struct destroy in loop", async () => {
		const input = `
struct Resource {
  var int handle

  func #destroy = (ref self) {
    self.handle = -1
  }
}

var int i = 0
while i < 3 {
  var Resource r = Resource(i)
  i += 1
  if i == 2 {
    continue
  }
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(result.code).toContain("bl Resource_destroy");
		expect(result.code.match(/bl Resource_destroy/g)?.length).toBe(2);

		await build_and_check_output(input, "leak_continue_struct_destroy", "done");
	});

	test("assigning class to another does not double-free", async () => {
		const input = `
class Box {
  var int value
}

var Box s = Box(1)
var Box t = Box(2)
t = s
Console.write("\\{s.value}")
Console.write("\\{t.value}")
`;
		await build_and_check_output(input, "dfree_assign_class", "11");
	});

	test("returning class is not use-after-free", async () => {
		const input = `
class Box {
  var int value
}

func make_box = (int x, out Box) {
  var Box b = Box(x)
  return b
}
var Box result = make_box(42)
Console.write("\\{result.value}")
`;
		await build_and_check_output(input, "dfree_return_class", "42");
	});

	test("returning class from nested scope does not leak", async () => {
		const input = `
class Box {
  var int value
}

func get_box = (int x, out Box) {
  var Box b = Box(x)
  if x == 42 {
    return b
  }
  return b
}
var Box result = get_box(42)
Console.write("\\{result.value}")
`;
		await build_and_check_output(input, "dfree_return_nested_class", "42");
	});

	test("reassigning class frees old value", async () => {
		const input = `
class Box {
  var int value
}

var Box s = Box(1)
s = Box(2)
Console.write("\\{s.value}")
`;
		await build_and_check_output(input, "dfree_reassign_class", "2");
	});

	test("returning class from nested scope frees old instance", async () => {
		const input = `
class Box {
  var int value
}

func get_box = (int x, out Box) {
  var Box b = Box(x)
  if x == 42 {
    return b
  }
  return b
}
var Box result = get_box(42)
Console.write("\\{result.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(result.code).toContain("bl _nomen_free_wrap");
		expect(result.code).toContain("bl Box_init");

		await build_and_check_output(input, "dfree_class_nested_scope_leaks", "42");
	});

	test("class with string field does not leak on destroy", async () => {
		const input = `
class Named {
  var int id
  var string name
}

var int id = 1
var string name = 42.to_string()
var Named n = Named(id, name)
Console.write("\\{n.id}")
`;
		await build_and_check_output(input, "dfree_class_string_field", "1");
	});

	test("break does not leak class in loop body", async () => {
		const input = `
class Box {
  var int value
}

var int i = 0
while i < 3 {
  var Box b = Box(i)
  if i == 1 {
    i += 1
    break
  }
  Console.write("\\{b.value}")
  i += 1
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_break_class", "0done");
	});

	test("continue does not leak class in loop body", async () => {
		const input = `
class Box {
  var int value
}

var int i = 0
while i < 3 {
  var Box b = Box(i)
  i += 1
  if i == 2 {
    continue
  }
  Console.write("\\{b.value}")
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_continue_class", "02done");
	});

	test("aliasing class via declaration then reassigning original is not UAF", async () => {
		const input = `
class Box {
  var int value
}

var Box a = Box(42)
var Box b = a
a = Box(99)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "uaf_class_alias_then_reassign", "42");
	});

	test("assigning class to another variable does not leak old value", async () => {
		const input = `
class Box {
  var int value
}

var Box s = Box(42)
var Box t = s
Console.write("\\{t.value}")
`;
		await build_and_check_output(input, "leak_class_alias_declaration", "42");
	});

	test("while loop break does not leak class", async () => {
		const input = `
class Box {
  var int value
}

var int i = 0
while i < 3 {
  var Box b = Box(i)
  i += 1
  if i == 2 {
    break
  }
  Console.write("\\{b.value}")
}
Console.write("done")
`;
		await build_and_check_output(input, "leak_while_break_class", "0done");
	});

	test("break runs class destroy in loop", async () => {
		const input = `
class Resource {
  var int handle

  func #destroy = (ref self) {
    self.handle = -1
  }
}

var int i = 0
while i < 3 {
  var Resource r = Resource(i)
  if i == 1 {
    i += 1
    break
  }
  i += 1
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(result.code).toContain("bl _nomen_free_wrap");
		expect(result.code.match(/bl _nomen_free_wrap/g)?.length).toBe(2);

		await build_and_check_output(input, "leak_break_class_destroy", "done");
	});

	test("continue runs class destroy in loop", async () => {
		const input = `
class Resource {
  var int handle

  func #destroy = (ref self) {
    self.handle = -1
  }
}

var int i = 0
while i < 3 {
  var Resource r = Resource(i)
  i += 1
  if i == 2 {
    continue
  }
}
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(result.code).toContain("bl _nomen_free_wrap");
		expect(result.code.match(/bl _nomen_free_wrap/g)?.length).toBe(2);

		await build_and_check_output(input, "leak_continue_class_destroy", "done");
	});

	test("reassigning struct from self method call does not double-free buffer", async () => {
		const input = `
var BigInt k = BigInt()
k = k.new(1)
var BigInt k2 = BigInt()
k2 = k2.new(2)
k = k2.new(3)
var int d = k.to_digit()
Console.write(d.to_string())
`;
		await build_and_check_output(input, "dfree_struct_self_method_reassign", "3");
	});

	test("struct reassignment in loop does not double-free buffer", async () => {
		const input = `
var BigInt k = BigInt()
var int i = 0
while i < 3 {
	k = k.new(i)
	var int d = k.to_digit()
	Console.write(d.to_string())
	i += 1
}
`;
		await build_and_check_output(input, "dfree_struct_loop_reassign", "012");
	});

	test("class field access borrow is not destroyed", async () => {
		const input = `
class Box {
  var int value
}

class Holder {
  mov Box box
}

func get_value = (Holder h, out int) {
  var Box b = h.box
  return b.value
}

var Box box = Box(42)
var Holder h = Holder(mov box)
var int v = get_value(h)
Console.write("\\{v}")
`;
		await build_and_check_output(input, "dfree_class_field_borrowed_ref", "42");
	});
});

describe("returning a borrowed string", () => {
	// Regression: a function that returns a string it does NOT own — a
	// parameter passed through, a borrow-initialized local, a container
	// `.at(i)` result, or a literal local — handed the caller a non-owned
	// pointer. The C backend strdup's every string return so the caller can
	// free it, but it missed bare-variable/borrow-accessor returns; the
	// aarch64 backend classifies a function as heap-returning via an AST walk,
	// but `value_is_owned_string` treated every non-literal variable as owned.
	// Both crashed (the caller freed a borrowed/static pointer).

	test("returning a string parameter", async () => {
		const input = `
func echo = (string s, out string) {
  return s
}
const string r = echo("hello")
Console.write(r)
`;
		await build_and_check_output(input, "dfree_return_param", "hello");
	});

	test("returning a borrow-initialized local", async () => {
		const input = `
func first_or = (List<string> xs, string fallback, out string) {
  if xs.length > 0 {
    const string t = xs.at(0)
    return t
  }
  return fallback
}
var List<string> names = List<string>()
names.push("zebra")
const string r = first_or(names, "none")
Console.write(r)
`;
		await build_and_check_output(input, "dfree_return_borrow_local", "zebra");
	});

	test("returning a container .at directly", async () => {
		const input = `
func first_or = (List<string> xs, string fallback, out string) {
  if xs.length > 0 {
    return xs.at(0)
  }
  return fallback
}
var List<string> names = List<string>()
names.push("ok")
const string r = first_or(names, "none")
Console.write(r)
`;
		await build_and_check_output(input, "dfree_return_at_direct", "ok");
	});

	test("returning a literal local", async () => {
		const input = `
func label = (int n, out string) {
  if n > 0 {
    const string pos = "positive"
    return pos
  }
  const string zero = "zero"
  return zero
}
const string r = label(5)
Console.write(r)
`;
		await build_and_check_output(input, "dfree_return_literal_local", "positive");
	});

	test("returning an owned local still does not leak or double-free", async () => {
		// `s` is an owned heap string (from to_string); returning it transfers
		// ownership to the caller. It must not be strdup'd (that would leak the
		// original) and must not be freed at the callee's scope exit.
		const input = `
func make_greeting = (int x, out string) {
  var string s = x.to_string()
  if x == 42 {
    return s
  }
  return s
}
var string result = make_greeting(42)
Console.write(result)
`;
		await build_and_check_output(input, "dfree_return_owned_no_leak", "42");
	});
});

describe("returning a container borrow (backend parity)", () => {
	// Regression for the "Backend divergence: returning a container borrow"
	// follow-up: on the C backend a function returning `xs.at(i)` handed the
	// caller an independent (strdup'd) copy, while the aarch64 backend passed
	// the raw borrow through — tied to the receiver's storage (the result
	// observed later mutations of the source container). The aarch64 backend
	// now normalizes container-borrow returns at the return site (a strdup,
	// mirroring the C backend's boundary-strdup), so both backends hand the
	// caller an owned copy. Pinned by mutating the source container after the
	// call: the result keeps the ORIGINAL element value on both backends
	// (pre-fix aarch64 printed the replacement — the borrow aliased the slot,
	// which `set` frees and refills).

	test("returning a container .at directly yields an independent copy", async () => {
		const input = `
func pick = (List<string> xs, out string) {
	var int i = 0
	if i >= 0 && i < xs.length {
		return xs.at(i)
	}
	return "none"
}
var List<string> names = List<string>()
names.push("zebra")
const string r = pick(names)
var int j = 0
if j >= 0 && j < names.length {
	names.set(j, "viper")
}
Console.write(r)
`;
		await build_and_check_output(input, "dfree_return_at_copy", "zebra");
	});

	test("returning a borrow-initialized local yields an independent copy", async () => {
		const input = `
func pick_via_local = (List<string> xs, out string) {
	var int i = 0
	if i >= 0 && i < xs.length {
		const string t = xs.at(i)
		return t
	}
	return "none"
}
var List<string> names = List<string>()
names.push("zebra")
const string r = pick_via_local(names)
var int j = 0
if j >= 0 && j < names.length {
	names.set(j, "viper")
}
Console.write(r)
`;
		await build_and_check_output(input, "dfree_return_borrow_local_copy", "zebra");
	});

	test("a borrow fallback alongside a container borrow is also normalized", async () => {
		// The heap classification is whole-function: once ANY return is owned
		// (the `.at` here), the caller frees EVERY result — so the parameter
		// fallback branch must be copied too, not passed through raw.
		const input = `
func first_or = (List<string> xs, string fallback, out string) {
	var int i = 0
	if i >= 0 && i < xs.length {
		return xs.at(i)
	}
	return fallback
}
var List<string> names = List<string>()
const string r = first_or(names, "none")
Console.write(r)
`;
		await build_and_check_output(input, "dfree_return_at_param_fallback", "none");
	});

	test("returning a container borrow via match yields an independent copy", async () => {
		const input = `
func pick_match = (List<string> xs, int c, out string) {
	var int i = 0
	if i >= 0 && i < xs.length {
		return match c {
			case 1 -> xs.at(i)
			else -> "none"
		}
	}
	return "none"
}
var List<string> names = List<string>()
names.push("zebra")
const string r = pick_match(names, 1)
var int j = 0
if j >= 0 && j < names.length {
	names.set(j, "viper")
}
Console.write(r)
`;
		await build_and_check_output(input, "dfree_return_at_match_copy", "zebra");
	});

	test("Map<string> get yields an independent copy", async () => {
		const input = `
var Map<int, string> m = Map<int, string>()
m.set(1, "zebra")
const string r = m.get(1)
m.set(1, "viper")
Console.write(r)
`;
		await build_and_check_output(input, "dfree_map_get_copy", "zebra");
	});

	test("the accessor itself still returns a borrow (no copy leaked)", async () => {
		// `.at`'s own body keeps the borrow: `List<string>.at` is named `at`,
		// one of the call-site borrow accessors, so it does NOT strdup (its
		// callers treat the result as a non-owned borrow and never free it —
		// a copy would leak under the audit detector).
		const input = `
var List<string> names = List<string>()
names.push("zebra")
var int i = 0
if i >= 0 && i < names.length {
	const string s = names.at(i)
	Console.write(s)
}
`;
		await build_and_check_output(input, "dfree_at_still_borrow", "zebra");
	});

	test("a field borrow return alongside a heap branch is normalized", async () => {
		// Same whole-function rule: `maybe_render` is heap-returning (the
		// to_string branch), so the caller frees EVERY result — the field
		// branch must copy its borrow instead of handing over storage that
		// belongs to the struct (a rodata literal here, which free rejects).
		const input = `
struct Named {
	var string name
}
func maybe_render = (Named n, int c, out string) {
	if c > 0 {
		return n.name
	}
	return c.to_string()
}
var Named n = Named("ann")
const string r = maybe_render(n, 1)
Console.write(r)
`;
		await build_and_check_output(input, "dfree_return_field_mixed", "ann");
	});
});

describe("container ownership across function boundaries", () => {
	// Regression for the "RAII double-free when the same class instance is
	// referenced by two lists" roadblock. Previously: `dels.push(src.at(i))`
	// silently compiled and crashed at runtime (SIGABRT) — both lists freed
	// the same class pointer on destroy. The checker now rejects the
	// shared-ownership pattern at compile time (see test/uaf-via-container),
	// and the CORRECT pattern (`pop` to extract ownership) round-trips a
	// class across a function boundary with no leak and no double-free.

	test("pop transfers ownership across a function boundary (no double-free)", async () => {
		const input = `
class Item { var int value = 0 }
func fill = (ref List<Item> items, int n) {
  var int i = 0
  while i < n {
    var Item x = Item()
    x.value = i
    items.push(mov x)
    i = i + 1
  }
}
func drain = (ref List<Item> src, out List<Item>) {
  var List<Item> dst = List<Item>()
  while src.length > 0 {
    dst.push(src.pop())
  }
  return dst
}
var List<Item> units = List<Item>()
fill(ref units, 3)
var List<Item> moved = drain(ref units)
var int sum = 0
var int i = 0
while i < moved.length {
  sum = sum + moved.at(i).value
  i = i + 1
}
Console.write("\\{sum}")
`;
		// Items pushed with values 0, 1, 2; popped in reverse; sum is 0+1+2 = 3.
		await build_and_check_output(input, "dfree_pop_across_fn", "3");
	});
});
