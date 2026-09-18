import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Flow-sensitive bounds checking: when an enclosing if/while/for establishes
// `j < list.length`, the compiler knows `list.at(j)` satisfies its
// `i: i >= 0 && i < self.length` constraint. The constraint `self.length`
// resolves to `list.length` (self = list), matching the known bound on `j`.
// Reassignment of `j` invalidates the bound.

describe("flow-sensitive bounds checking", () => {
	test("list.at(j) inside while j < list.length compiles clean", async () => {
		const input = `
var List<int> list = List<int>()
list.push(10)
list.push(20)
list.push(30)
var int sum = 0
var int j = 0
while j < list.length {
	sum = sum + list.at(j)
	j = j + 1
}
Console.write("\\{sum}\\n")
`;
		await build_and_check_output(input, "flow_while", "60\n");
	});

	test("list.at(i) inside for i of 0..list.length compiles clean", async () => {
		const input = `
var List<int> list = List<int>()
list.push(1)
list.push(2)
list.push(3)
var int product = 1
for i of 0 .. list.length {
	product = product * list.at(i)
}
Console.write("\\{product}\\n")
`;
		await build_and_check_output(input, "flow_for", "6\n");
	});

	test("if j < list.length guard allows list.at(j)", async () => {
		const input = `
var List<int> list = List<int>()
list.push(10)
list.push(20)
var int j = 1
if j < list.length {
	var int x = list.at(j)
	Console.write("\\{x}\\n")
}
`;
		await build_and_check_output(input, "flow_if", "20\n");
	});

	test("compound condition j >= 0 && j < list.length", async () => {
		const input = `
var List<int> list = List<int>()
list.push(10)
list.push(20)
var int j = 1
if j >= 0 && j < list.length {
	Console.write("\\{list.at(j)}\\n")
}
`;
		await build_and_check_output(input, "flow_compound", "20\n");
	});

	test("nested while loops with different containers", async () => {
		const input = `
var List<int> outer = List<int>()
outer.push(0)
outer.push(1)
var int oi = 0
while oi < outer.length {
	var List<int> inner = List<int>()
	inner.push(10)
	inner.push(20)
	var int ii = 0
	while ii < inner.length {
		Console.write("\\{outer.at(oi)}\\{inner.at(ii)} ")
		ii = ii + 1
	}
	oi = oi + 1
}
Console.write("\\n")
`;
		await build_and_check_output(input, "flow_nested", "010 020 110 120 \n");
	});
});

// Literal-on-left bounds: `if list.count > 0` establishes a lower bound on
// list.count, so a constraint like `idx < self.count` (i.e. `0 < list.count`
// when idx is a literal/const) verifies via the symmetric (flipped) comparison.

describe("literal-on-left bounds", () => {
	test("list.at(0) verifies inside if list.count > 0", () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
list.add(1)
list.add(2)
if list.count > 0 {
	var int a = list.at(0)
	Console.write("\\{a}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("list.at(1) verifies inside if list.count > 1", () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
list.add(1)
list.add(2)
if list.count > 1 {
	var int b = list.at(1)
	Console.write("\\{b}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("list.at(0) still errors when count could be zero", () => {
		const input = `
var LinkedList<int> list = LinkedList<int()
list.add(1)
var int a = list.at(0)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((m) => m.message.includes("cannot be verified"))).toBe(true);
	});
});

// Variable-to-variable bound propagation: assigning `x = y` should copy y's
// flow-sensitive bounds onto x, so downstream uses of x can verify against
// those bounds (e.g. proving `x >= 0` for `Array.with(0, x)`).

describe("variable-to-variable bound propagation", () => {
	test("bounds propagate from source to target on assignment", () => {
		const input = `
var int y = 0
if y > 0 {
	var int x = y
	var Array<int> a = Array.with(0, x)
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("bounds propagate through reassignment in a loop", async () => {
		const input = `
var List<int> list = List<int>()
list.push(10)
list.push(20)
list.push(30)
var int j = 0
while j < list.length {
	var int k = j
	Console.write("\\{list.at(k)}\\n")
	j = j + 1
}
`;
		await build_and_check_output(input, "flow_var_to_var", "10\n20\n30\n");
	});
});

// Return-contract propagation: a method whose return type carries a contract
// (e.g. Graph.edge_target `out int: out >= 0 && out < self.node_count`) gives
// the result a tracked bound. The bound flows both to a named variable and to
// an inline (nested) call argument, so a downstream `.at(...)` constraint
// verifies without a runtime guard.

describe("return-contract propagation", () => {
	test("return contract binds the LHS variable", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(10)
g.add_node(20)
g.add_edge(0, 1)
var int e = g.edges_of(0)
var int target = g.edge_target(e)
var int v = g.at(target)
Console.write("\\{v}\\n")
`;
		await build_and_check_output(input, "rc_lhs", "20\n");
	});

	test("return contract propagates through a nested call argument", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(10)
g.add_node(20)
g.add_edge(0, 1)
var int e = g.edges_of(0)
var int v = g.at(g.edge_target(e))
Console.write("\\{v}\\n")
`;
		await build_and_check_output(input, "rc_nested", "20\n");
	});

	test("return contract with == pins an exact value (both bounds)", async () => {
		// `zero` declares `out int: out == 0`. Propagated as an inclusive
		// two-sided bound, that satisfies `slot`'s `i >= 0 && i <= 0` (i.e. i
		// must be exactly 0) — something a strict `<`/`>` contract couldn't.
		// Before `==` return contracts were handled, the bound was dropped and
		// this failed with "cannot be verified".
		const input = `
struct Const {
  func zero = (out int: out == 0) {
    return 0
  }
  func slot = (int i: i == 0, out int) {
    return i
  }
}
var Const c = Const()
var int v = c.slot(c.zero())
Console.write("\\{v}")
`;
		await build_and_check_output(input, "rc_eq", "0");
	});

	test("return contract does not cross different receivers", () => {
		// edge_target's bound is on g1, but .at is called on g2 — the bound
		// doesn't transfer, so this must error rather than silently pass.
		const input = `
var Graph<int> g1 = Graph<int>()
var Graph<int> g2 = Graph<int>()
g1.add_node(1)
g1.add_node(2)
g1.add_edge(0, 1)
g2.add_node(3)
var int e = g1.edges_of(0)
var int v = g2.at(g1.edge_target(e))
Console.write("\\{v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((m) => m.message.includes("cannot be verified"))).toBe(true);
	});
});

// Non-negative container-size family: `.length` / `.cap` / `.count` / `.size`
// are always >= 0, and a variable that aliases one of these accesses (or an
// argument that IS such an access) carries that non-negativity through to
// constraint verification. Without this, three concrete shapes all errored
// with "cannot be verified":
//   1. `Array.with(0, list.length)` — the count arg is `list.length`; the
//      constraint `count >= 0` couldn't see through the parameter name.
//   2. `var int e = text.length; text.slice(0, e)` — after the assignment,
//      `e >= 0` (for slice's `end >= start`) wasn't provable.
//   3. `if e > text.length { e = text.length }; text.slice(s, e)` — the clamp
//      guard's post-if state didn't carry `e <= text.length` over to the slice.
// All three are now discharged by recognizing the non-negative access
// (directly or through an alias) and by applying the negated condition's
// bounds to the parent for a no-else fall-through `if`.

describe("non-negative container size", () => {
	test("Array.with(0, list.length) verifies count >= 0", async () => {
		const input = `
var List<int> xs = List<int>()
xs.push(1)
xs.push(2)
var Array<int> a = Array<int>.with(0, xs.length)
Console.write("\\{a.length}")
`;
		await build_and_check_output(input, "nonneg_with_list_length", "2");
	});

	test("Array.with(0, runtime string.length) verifies count >= 0", () => {
		const input = `
var string a = "ab"
var string b = "cd"
var string s = a + b
var Array<int> z = Array<int>.with(0, s.length)
Console.write("\\{z.length}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("var int e = text.length; slice(0, e) verifies end bounds", async () => {
		const input = `
var string text = "hello"
var int e = 100
e = text.length
var view string v = text.slice(0, e)
Console.write("\\{v.length}")
`;
		await build_and_check_output(input, "nonneg_assign_then_slice", "5");
	});

	test("clamp guard establishes e <= text.length for slice", async () => {
		// The headline ROADBLOCKS case. `if e > text.length { e = text.length }`
		// is a clamp: both fall-through paths agree on `e <= text.length`, and
		// the negated-bound application on the parent (plus the alias-based
		// explicit bounds from the assignment) make the slice verify.
		const input = `
var string text = "hello world"
var int s = 0
var int e = 100
if e > text.length {
	e = text.length
}
var view string v = text.slice(s, e)
Console.write("\\{v.length}")
`;
		await build_and_check_output(input, "nonneg_clamp_guard", "11");
	});

	test("clamp guard with literal 0 start also verifies", async () => {
		const input = `
var string text = "hello world"
var int e = 100
if e > text.length {
	e = text.length
}
var view string v = text.slice(0, e)
Console.write(v.to_string())
`;
		await build_and_check_output(input, "nonneg_clamp_guard_lit0", "hello world");
	});

	test("Array.with(0, n) where n aliases list.length", () => {
		// Variable-to-alias propagation: `var int n = list.length` records
		// `n.range_lower = 0` via the non-negative-field assignment rule, so
		// `Array.with(0, n)`'s `count >= 0` constraint verifies through n.
		const input = `
var List<int> xs = List<int>()
xs.push(1)
var int n = xs.length
var Array<int> a = Array<int>.with(0, n)
Console.write("\\{a.length}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});
