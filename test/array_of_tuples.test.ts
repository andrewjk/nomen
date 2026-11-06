import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import { compile_main } from "./spec/_helpers";

/**
 * Bracket-aggregate composition: arrays of tuples, the nested-raw-array
 * rejections, and the base-spread (`[ .. base, ... ]` ) base-type rules.
 * See SPEC "Arrays of Tuples" and the tuple-spread follow-up history.
 *
 * Array-of-tuples elements are limited to NON-owning shapes ([int, bool],
 * ...): literal-seeded string/mv tuple fields hold rodata, and any element
 * copy out of the array frees one (AUDIT-STALE-FREE) — owning elements are
 * a clear check error until element seeding produces uniformly heap fields.
 */
describe("array of tuples", () => {
	test("annotated [T1, T2][] accepts tuple-element literals", () => {
		const input = `
	var [int, bool][] flags = [[1, true], [2, false]]
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("Array<[T1, T2]> spelling", () => {
		const input = `
	var Array<[int, bool]> flags = [[3, true]]
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("same-shaped tuple elements infer an ARRAY of tuples (not a tuple of tuples)", () => {
		const input = `
	var flags = [[1, true], [2, false]]
	var int n = flags.at(1)._0
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("destructure a tuple element out of the array", () => {
		const input = `
	var [int, bool][] flags = [[1, true]]
	var [n, b] = flags.at(0)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("heterogeneous inner shapes still tuple-ize the outer literal", () => {
		const input = `
	var mixed = [[1, true], [2, false, 3]]
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("owning tuple elements are seeded heap (string fields)", () => {
		const input = `
	var [int, string][] pairs = [[1, "a"], [2, "b"]]
	var string s = pairs.at(1)._1.copy()
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("inferred owning-element arrays work too", () => {
		const input = `
	var pairs = [[1, "a"], [2, "b"]]
	Console.write("\\{pairs.at(0)._1}")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("destructuring an owning element out of the array is rejected", () => {
		const input = `
	var [int, string][] pairs = [[1, "a"]]
	var [n, s] = pairs.at(0)
`;
		expect(
			compile_main(input).some((e) =>
				e.message.includes("cannot destructure 'string' out of an array element"),
			),
		).toBe(true);
	});

	test("run: owning-element construction and field reads", async () => {
		const input = `
var [int, string][] pairs = [[1, "a"], [2, "b"]]
Console.write("\\{pairs.at(0)._0} \\{pairs.at(1)._1}")
`;
		await build_and_check_output(input, "array_of_tuples_owning", "1 b");
	});

	test("run: inferred owning-element array", async () => {
		const input = `
var pairs = [[1, "a"], [2, "b"]]
Console.write("\\{pairs.at(1)._0} \\{pairs.at(0)._1}")
`;
		await build_and_check_output(input, "array_of_tuples_owning_infer", "2 a");
	});

	test("run: copying an owning element out", async () => {
		const input = `
var [int, string][] pairs = [[1, "a"]]
var e = pairs.at(0)
Console.write("\\{e._0} \\{e._1} \\{pairs.at(0)._1}")
`;
		await build_and_check_output(input, "array_of_tuples_owning_copyout", "1 a a");
	});

	test("run: index and read tuple fields", async () => {
		const input = `
var [int, bool][] flags = [[1, true], [2, false]]
Console.write("\\{flags.at(1)._0} \\{flags.at(1)._1}")
`;
		await build_and_check_output(input, "array_of_tuples_read", "2 false");
	});

	test("run: inferred array of tuples", async () => {
		const input = `
var flags = [[1, true], [2, false]]
Console.write("\\{flags.at(0)._1}")
`;
		await build_and_check_output(input, "array_of_tuples_inferred", "true");
	});

	test("run: destructure an element", async () => {
		const input = `
var [int, bool][] flags = [[1, true], [2, false]]
var [n, b] = flags.at(1)
Console.write("\\{n} \\{b}")
`;
		await build_and_check_output(input, "array_of_tuples_destructure", "2 false");
	});
});

describe("nested raw arrays", () => {
	// Full nested-array coverage lives in nested_arrays.test.ts.
	test("int[][] parses (fixed outer, heap inner)", () => {
		const input = `
pub func main = () {
	var int[][] grid = [[1, 2], [3, 4]]
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("Array<Array<int>> parses", () => {
		const input = `
pub func main = () {
	var Array<Array<int>> grid = [[1, 2], [3, 4]]
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("array literal elements infer an array of arrays", () => {
		const input = `
pub func main = () {
	var grid = [[1, 2], [3, 4]]
	var int n = grid.at(0).at(1)
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});
});

describe("base-spread base types", () => {
	test("struct base still spreads", () => {
		const input = `
struct LayoutParams {
	var int grow = 0
	var int shrink = 0
}
pub func main = () {
	const P = [ .. LayoutParams(), grow = 2 ]
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("tuple base is rejected (no overridable fields)", () => {
		const input = `
pub func main = () {
	var base = [1, "a"]
	var [int, string] t = [ .. base ]
}
`;
		const parsed = parse(input);
		expect(
			parsed.errors.some((e) => e.message.includes("needs a struct base with overridable fields")),
		).toBe(true);
	});

	test("tuple base with an override is rejected", () => {
		const input = `
pub func main = () {
	var [int, string] t = [ .. [1, "a"], _0 = 5 ]
}
`;
		const parsed = parse(input);
		expect(
			parsed.errors.some((e) => e.message.includes("needs a struct base with overridable fields")),
		).toBe(true);
	});

	test("array base is rejected with an array-aware message", () => {
		const input = `
pub func main = () {
	var int[] a = [ .. [1, 2] ]
}
`;
		const parsed = parse(input);
		expect(
			parsed.errors.some((e) =>
				e.message.includes("Array<int> is an array; use '+' to concatenate arrays"),
			),
		).toBe(true);
	});
});
