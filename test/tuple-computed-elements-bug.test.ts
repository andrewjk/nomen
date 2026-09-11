import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Regression coverage for a fixed bug: a tuple literal whose elements are
// computed expressions (not simple parameter references or literals) used to
// produce the wrong value for every element after the first
// (`return [a + 1, a + 2]` for a = 10 yielded t._1 == 1 instead of 12).
// Fixed at some point before Sep 2026 (all shapes below pass on both
// backends); these tests pin the correct behavior.

describe("tuple computed elements", () => {
	test("tuple of computed expressions keeps correct values", async () => {
		const input = `
func make = (int a, out [int, int]) {
	return [a + 1, a + 2]
}
const t = make(10)
Console.write("\\{t._0} \\{t._1}")
`;
		await build_and_check_output(input, "tuple_computed_elems_bug", "11 12");
	});

	test("tuple of division/modulo expressions keeps correct values", async () => {
		const input = `
func split = (int total, out [int, int]) {
	return [total / 100, total % 100]
}
const t = split(500)
Console.write("\\{t._0} \\{t._1}")
`;
		await build_and_check_output(input, "tuple_divmod_elems_bug", "5 0");
	});
});
