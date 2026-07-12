import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// BUG: a tuple literal whose elements are computed expressions (not simple
// parameter references or literals) produces the wrong value for every
// element after the first.
//
// `return [a + 1, a + 2]` for a = 10 yields t._0 == 11 (correct) but
// t._1 == 1 (should be 12). The equivalent with simple param refs —
// `return [a, b]` — works fine (see "tuple returned from function" in
// tuples.test.ts), so the bug is specific to non-trivial element expressions.

describe("tuple computed element bug", () => {
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
