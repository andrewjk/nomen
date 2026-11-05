import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

/**
 * Nested arrays (`int[][]`, `Array<Array<int>>`, `[[1, 2], [3, 4]]`).
 *
 * A nested array has a FIXED outer level (a stack array of `Array_<T>*`
 * pointers) and HEAP inner levels — the inner buffer's inline variable-size
 * storage can only be referenced, never embedded. Two levels are supported;
 * inner elements must be non-owning (scalar) for now.
 */
describe("nested arrays", () => {
	test("inferred nested read", async () => {
		const input = `
var g = [[1, 2], [3, 4]]
Console.write("\\{g.at(1).at(0)} \\{g.at(0).at(1)}")
`;
		await build_and_check_output(input, "nested_infer", "3 2");
	});

	test("annotated int[][] read + lengths", async () => {
		const input = `
var int[][] g = [[1, 2], [3, 4]]
Console.write("\\{g.length} \\{g.at(0).length} \\{g.at(1).length}")
`;
		await build_and_check_output(input, "nested_annot", "2 2 2");
	});

	test("Array<Array<int>> spelling", async () => {
		const input = `
var Array<Array<int>> g = [[5, 6]]
Console.write("\\{g.at(0).at(1)}")
`;
		await build_and_check_output(input, "nested_alias", "6");
	});

	test("mixed inner lengths", async () => {
		const input = `
var g = [[1, 2, 3], [4]]
Console.write("\\{g.at(0).length} \\{g.at(1).length} \\{g.at(1).at(0)}")
`;
		await build_and_check_output(input, "nested_mixed", "3 1 4");
	});

	test("fixed-length outer", async () => {
		const input = `
var int[2][] g = [[1], [2, 3]]
Console.write("\\{g.at(1).at(1)}")
`;
		await build_and_check_output(input, "nested_fixed", "3");
	});

	test("row loop idiom (row local + bounds)", async () => {
		const input = `
var g = [[1, 2], [3, 4]]
var int total = 0
var int i = 0
while i < g.length {
	var row = g.at(i)
	var int j = 0
	while j < row.length {
		total = total + row.at(j)
		j = j + 1
	}
	i = i + 1
}
Console.write("\\{total}")
`;
		await build_and_check_output(input, "nested_rows", "10");
	});

	test("set through an inner row", async () => {
		const input = `
var g = [[1, 2], [3, 4]]
g.at(0).set(1, 9)
Console.write("\\{g.at(0).at(0)} \\{g.at(0).at(1)}")
`;
		await build_and_check_output(input, "nested_set", "1 9");
	});

	test("for-of over rows", async () => {
		const input = `
var g = [[1, 2], [3, 4]]
for row of g {
	var int j = 0
	while j < row.length {
		Console.write("\\{row.at(j)}")
		j = j + 1
	}
}
`;
		await build_and_check_output(input, "nested_forof", "1234");
	});

	test("wrong inner element type is rejected", () => {
		const input = `
pub func main = () {
	var int[][] g = [["a", "b"]]
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("string inner elements are rejected for now", () => {
		const input = `
pub func main = () {
	var string[][] g = [["a"], ["b"]]
}
`;
		const parsed = parse(input);
		expect(
			parsed.errors.some((e) => e.message.includes("inner element cannot own heap resources")),
		).toBe(true);
	});

	test("three levels are rejected", () => {
		const input = `
var int[][][] g = [[[1]]]
`;
		const parsed = parse(input);
		expect(
			parsed.errors.some((e) => e.message.includes("deeper than two levels are not supported")),
		).toBe(true);
	});
});
