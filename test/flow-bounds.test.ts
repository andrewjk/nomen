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
