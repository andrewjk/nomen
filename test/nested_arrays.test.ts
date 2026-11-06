import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

/**
 * Nested arrays (`int[][]`, `Array<Array<int>>`, `[[1, 2], [3, 4]]`, and
 * deeper chains `int[][][]`).
 *
 * A nested array is HEAP-OF-POINTERS at every level: each level is a heap
 * `Array_<T>`-shaped buffer whose slots are `Array_<T>*` row pointers (the
 * innermost level holds scalars/owning values). A nested array value is a
 * single pointer — returnable, storable in struct fields, passable as a
 * parameter (a borrow). Owning inner elements (strings, mv structs) are
 * allowed; the destroy walks reclaim the rows recursively.
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

	test("string inner elements own their rows (audit clean)", async () => {
		const input = `
var g = [["ab", "cd"], ["ef"]]
Console.write("\\{g.at(0).at(1)} \\{g.at(1).at(0)} \\{g.at(0).length}")
`;
		await build_and_check_output(input, "nested_strings", "cd ef 2");
	});

	test("string[][] set + lengths", async () => {
		const input = `
var string[][] g = [["a"], ["b", "c"]]
g.at(1).set(0, "z")
Console.write("\\{g.at(1).at(0)} \\{g.at(1).length}")
`;
		await build_and_check_output(input, "nested_strings_set", "z 2");
	});

	test("three levels read + write", async () => {
		const input = `
var int[][][] g = [[[1, 2], [3]], [[4]]]
g.at(0).at(1).set(0, 9)
Console.write("\\{g.at(0).at(1).at(0)} \\{g.at(1).at(0).at(0)} \\{g.length} \\{g.at(0).length}")
`;
		await build_and_check_output(input, "nested_three", "9 4 2 2");
	});

	test("nested array returned from a function", async () => {
		const input = `
func make_grid = (out int[][]) {
	return [[1, 2], [3, 4, 5]]
}
var g = make_grid()
Console.write("\\{g.length} \\{g.at(1).at(2)} \\{g.at(0).length}")
`;
		await build_and_check_output(input, "nested_return", "2 5 2");
	});

	test("nested array literal returned from a function", async () => {
		const input = `
func make_grid = (out int[][]) {
	return [[7, 8]]
}
var g = make_grid()
Console.write("\\{g.at(0).at(1)} \\{g.length}")
`;
		await build_and_check_output(input, "nested_return_lit", "8 1");
	});

	test("nested array in a struct field (literal-seeded)", async () => {
		const input = `
struct Board {
	var int[][] grid
}
var b = Board([[1, 2], [3]])
Console.write("\\{b.grid.at(1).at(0)} \\{b.grid.at(0).at(1)}")
`;
		await build_and_check_output(input, "nested_field", "3 2");
	});

	test("nested array passed to a function (param borrow)", async () => {
		const input = `
func total = (int[][] g, out int) {
	var int t = 0
	var int i = 0
	while i < g.length {
		var int j = 0
		while j < g.at(i).length {
			t = t + g.at(i).at(j)
			j = j + 1
		}
		i = i + 1
	}
	return t
}
var g = [[1, 2], [3, 4]]
Console.write("\\{total(g)} \\{g.at(0).at(0)}")
`;
		await build_and_check_output(input, "nested_param", "10 1");
	});

	test("owning struct rows (mv element teardown)", async () => {
		const input = `
mv struct Rec {
	var string name
}
var g = [[Rec("a"), Rec("b")], [Rec("c")]]
Console.write("\\{g.at(0).at(1).name} \\{g.at(1).at(0).name} \\{g.at(0).length}")
`;
		await build_and_check_output(input, "nested_mv_rows", "b c 2");
	});
});
