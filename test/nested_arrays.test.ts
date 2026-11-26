import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

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
mv struct Board {
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

	test("library accessors on a row (at_or / at_or_panic)", async () => {
		const input = `
mv struct Rec {
	mv string name
}
var w = [["ab", "cd"], ["ef"]]
Console.write(w.at(1).at_or(0, "?") + w.at(0).at_or(1, "?") + w.at(1).at_or(5, "?") + " ")
var n = [[5, 6], [7]]
Console.write("\\{n.at(1).at_or(0, 9)} \\{n.at(0).at_or_panic(1)} ")
var r = [[Rec("a"), Rec("b")], [Rec("c")]]
Console.write(r.at(0).at_or_panic(1).name + r.at(1).at_or_panic(0).name + " ")
var t = [[[1, 2], [3]], [[4]]]
Console.write("\\{t.at(0).at(1).at_or(0, 9)}")
`;
		await build_and_check_output(input, "nested_row_accessors", "efcd? 7 6 bc 3");
	});

	test("owning struct rows (mv element teardown)", async () => {
		const input = `
mv struct Rec {
	mv string name
}
var g = [[Rec("a"), Rec("b")], [Rec("c")]]
Console.write("\\{g.at(0).at(1).name} \\{g.at(1).at(0).name} \\{g.at(0).length}")
`;
		await build_and_check_output(input, "nested_mv_rows", "b c 2");
	});

	test("first / at_end return the row (row-keyed Array mono)", async () => {
		const input = `import System
mv struct Rec {
	mv string name
}
pub func main = () {
	const g = [[1, 2], [3]]
	Console.write("\\{g.first().length} \\{g.at_end().length} \\{g.first().at_or(1, 0)} ")
	const w = [["ab", "cd"], ["ef"]]
	Console.write(w.first().at_or(1, "?") + w.at_end().at_or(0, "?") + " ")
	const r = [[Rec("a"), Rec("b")], [Rec("c")]]
	Console.write(r.first().at_or_panic(1).name + r.at_end().at_or_panic(0).name + " ")
	const t = [[[1, 2], [3]], [[4, 5, 6]]]
	Console.write("\\{t.first().length} \\{t.at_end().first().length} \\{t.first().at_end().at_or(0, 9)}")
}
`;
		await build_and_check_output(input, "nested_first_at_end", "2 1 2 cdef bc 2 3 3", true, {
			audit: true,
			js: true,
		});
	});

	test("set replaces a row (copy in, displaced row freed)", async () => {
		const input = `import System
mv struct Rec {
	mv string name
}
pub func main = () {
	var g = [[1, 2], [3]]
	g.set(1, [5, 6, 7])
	var row = [8, 9]
	g.set(0, row)
	g.set(1, g.at(0))
	Console.write("\\{g.at(0).length} \\{g.at(1).length} \\{row.length} ")
	var w = [["ab", "cd"], ["ef"]]
	w.set(0, ["x"])
	const r2 = ["p", "q"]
	w.set(1, r2)
	Console.write(w.at(0).at(0) + w.at(1).at(1) + r2.at(0) + " ")
	var r = [[Rec("a"), Rec("b")], [Rec("c")]]
	r.set(1, r.at(0))
	Console.write(r.at(1).at(1).name + r.at(0).at(0).name + " ")
	var t = [[[1, 2], [3]], [[4]]]
	t.set(1, [[5, 6, 7], [8]])
	t.at(0).set(1, [9, 9])
	Console.write("\\{t.at(1).at(0).length} \\{t.at(0).at(1).length}")
}
`;
		await build_and_check_output(input, "nested_set_rows", "2 2 2 xqp ba 3 2", true, {
			audit: true,
			js: true,
		});
	});

	test("set with a non-row value is rejected", () => {
		const parsed = parse(`var g = [[1, 2], [3]]
g.set(0, 5)`);
		expect(parsed.errors.map((e) => e.message)).toContain(
			"Type mismatch in param: int (expected a row of int)",
		);
	});

	test("with fills independent row copies", async () => {
		const input = `import System
mv struct Rec {
	mv string name
}
pub func main = () {
	const row = [1, 2]
	var s = Array<Array<int>>.with(row, 3)
	s.at(0).set(0, 9)
	s.set(2, [7])
	Console.write("\\{s.length} \\{s.at(0).at(0)} \\{s.at(1).at(0)} \\{s.at(2).length} \\{row.at(0)} ")
	const w = Array<Array<string>>.with(["a", "b"], 2)
	var r = Array<Array<Rec>>.with([Rec("x")], 2)
	r.set(0, [Rec("q"), Rec("z")])
	Console.write(w.at(1).at(1) + r.at(0).at(1).name + r.at(1).at(0).name + " ")
	const g = [[1], [2, 3]]
	const t = Array<Array<Array<int>>>.with(g, 2)
	const e = Array<Array<int>>.with([], 2)
	Console.write("\\{t.length} \\{t.at(1).at(1).at(1)} \\{e.at(1).length}")
}
`;
		await build_and_check_output(input, "nested_with_rows", "3 9 1 1 1 bzx 2 3 0", true, {
			audit: true,
			js: true,
		});
	});

	test("with a non-row value is rejected", () => {
		const parsed = parse_with_imports(`const s = Array<Array<int>>.with(5, 2)`);
		expect(parsed.errors.map((e) => e.message)).toContain(
			"Type mismatch in param: int (expected a row of int)",
		);
	});

	test("literal rows from variables are copied in", async () => {
		const input = `import System
mv struct Rec {
	mv string name
}
func make = (out Array<int>) {
	return Array<int>.with(4, 2)
}
pub func main = () {
	var r = [7, 8]
	var h = [r, [3], r]
	r.set(0, 1)
	h.at(0).set(1, 5)
	Console.write("\\{h.at(0).at(0)} \\{h.at(2).at(1)} \\{r.at(1)} ")
	var hr = Array<int>.with(7, 2)
	var g = [hr, make()]
	hr.set(0, 1)
	Console.write("\\{g.at(0).at(0)} \\{g.at(1).at(1)} ")
	const s = ["a"]
	var hs = Array<string>.with("b", 1)
	const q = [Rec("x")]
	const w = [s, hs]
	const k = [q, q]
	Console.write(w.at(0).at(0) + w.at(1).at(0) + k.at(1).at(0).name + " ")
	const n = [[1], [2, 3]]
	const t = [n, [[4]], n]
	const u = [n.at(1), [4]]
	Console.write("\\{t.at(2).at(1).at(1)} \\{u.at(0).length}")
}
`;
		await build_and_check_output(input, "nested_literal_var_rows", "7 8 8 7 4 abx 3 2", true, {
			audit: true,
			js: true,
		});
	});
});
