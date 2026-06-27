import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("flow_while", result, "60\n");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("flow_for", result, "6\n");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("flow_if", result, "20\n");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("flow_compound", result, "20\n");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("flow_nested", result, "010 020 110 120 \n");
	});
});
