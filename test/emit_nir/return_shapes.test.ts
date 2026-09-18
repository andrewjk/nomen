// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("return values of every expression shape emit through the NIR seam", () => {
	expect_byte_identical(`
func helper = (int v, out int) {
    return v * 2
}
func shape_test = (int n, out int) {
    if n == 0 {
        return 0
    }
    if n == 1 {
        return (n + 2) * 3
    }
    if n == 2 {
        return (n * n) as int
    }
    if n == 3 {
        return helper(n) + helper(n + 1)
    }
    return 0 - n
}
Console.write("\\{shape_test(0)} \\{shape_test(1)} \\{shape_test(2)} \\{shape_test(3)} \\{shape_test(9)}")
`);
});
