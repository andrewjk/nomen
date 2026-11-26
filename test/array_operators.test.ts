import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("array + and *", () => {
	test("flat arrays build fresh owned copies", async () => {
		const input = `import System
mv struct Rec {
	mv string name
}
pub func main = () {
	var a = [1, 2]
	const b = [3]
	const c = a + b
	const d = a * 2
	Console.write("\\{c.length} \\{c.at_or(2, 0)} \\{d.length} \\{d.at_or(3, 0)} ")
	var h = Array<int>.with(1, 2)
	const e = (h * 3) + [5]
	Console.write("\\{(h + h).length} \\{e.length} \\{e.at_or(6, 0)} ")
	Console.write("\\{([1] * 0).length} \\{([1] * -2).length} ")
	const s = ["x", "y"]
	var t = Array<string>.with("ab", 2)
	Console.write((s + ["z"]).at_or(2, "") + (s * 2).at_or(3, "") + (t + s).at_or(1, "") + " ")
	var r = [Rec("p")]
	var q = Array<Rec>.with(Rec("q"), 2)
	const rs = r + q
	const rm = q * 2
	Console.write(rs.at_or(2, Rec("-")).name + "\\{rm.length}")
}
`;
		await build_and_check_output(input, "array_operators_flat", "3 3 4 2 4 7 5 0 0 zyab q4", true, {
			audit: true,
			js: true,
		});
	});

	test("nested arrays copy every row", async () => {
		const input = `import System
mv struct Rec {
	mv string name
}
pub func main = () {
	var g = [[1, 2], [3]]
	const c = g + [[4]]
	const d = g * 2
	g.at(0).set(0, 9)
	Console.write("\\{c.length} \\{c.at(2).at(0)} \\{d.length} \\{c.at(0).at(0)} \\{d.at(2).at(0)} ")
	const w = [["a", "b"], ["c"]]
	const r = [[Rec("x")]]
	Console.write((w + [["d"]]).at(2).at(0) + (r * 2).at(1).at(0).name + " ")
	const t = [[[1, 2], [3]], [[4]]]
	const u = (t * 2) + t
	Console.write("\\{u.length} \\{u.at(4).at(1).length} \\{(t * 0).length}")
}
`;
		await build_and_check_output(input, "array_operators_nested", "3 4 4 1 1 dx 6 1 0", true, {
			audit: true,
			js: true,
		});
	});

	test("length of an array-returning call", async () => {
		const input = `import System
func make = (out Array<int>) {
	return Array<int>.with(4, 2)
}
pub func main = () {
	var xs = Array<int>.with(1, 5)
	Console.write_line("\\{make().length} \\{Array<int>.with(1, 3).length} \\{xs.copy().length}")
}
`;
		await build_and_check_output(input, "array_call_length", "2 3 5", true, {
			audit: true,
			js: true,
		});
	});

	test("operand mismatches are rejected", () => {
		const errors = (src: string) => parse_with_imports(src).errors.map((e) => e.message);
		expect(errors("const a = [1] + 5")).toContain(
			"Type mismatch in param: int (expected Array<int>)",
		);
		expect(errors(`const a = [1] * "x"`)).toContain(
			"Type mismatch in param: string (expected int)",
		);
		expect(errors("const a = [[1]] + [1]")).toContain(
			"Type mismatch in param: int (expected the same nesting of int)",
		);
		expect(errors(`const a = [[1]] * "x"`)).toContain(
			"Type mismatch in param: string (expected int)",
		);
	});
});
