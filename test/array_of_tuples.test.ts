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

	test("owning tuple elements are rejected (rodata teardown hazard)", () => {
		const input = `
	var [int, string][] pairs = [[1, "a"], [2, "b"]]
`;
		expect(
			compile_main(input).some((e) =>
				e.message.includes("an array-of-tuples element cannot own heap resources"),
			),
		).toBe(true);
	});

	test("inferred owning-element arrays are rejected too", () => {
		const input = `
	var pairs = [[1, "a"], [2, "b"]]
`;
		expect(
			compile_main(input).some((e) =>
				e.message.includes("an array-of-tuples element cannot own heap resources"),
			),
		).toBe(true);
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

describe("nested raw arrays are rejected", () => {
	test("int[][] does not parse", () => {
		const input = `
var int[][] grid = [[1, 2]]
`;
		const parsed = parse(input);
		expect(
			parsed.errors.some((e) => e.message.includes("nested raw arrays are not supported")),
		).toBe(true);
	});

	test("Array<Array<int>> does not parse", () => {
		const input = `
var Array<Array<int>> grid = [[1, 2]]
`;
		const parsed = parse(input);
		expect(parsed.errors.some((e) => e.message.includes("nested arrays are not supported"))).toBe(
			true,
		);
	});

	test("array literal elements cannot be arrays (clear error, not silent mistyping)", () => {
		const input = `
pub func main = () {
	var grid = [[1, 2], [3, 4]]
}
`;
		const parsed = parse(input);
		expect(
			parsed.errors.some((e) =>
				e.message.includes("an array literal element cannot itself be an array"),
			),
		).toBe(true);
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
