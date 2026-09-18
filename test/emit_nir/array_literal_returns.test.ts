// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("array literal returns ride the NIR element facts byte-identically", () => {
	expect_byte_identical(`
func triple = (out int[]) {
    return [4, 5, 6]
}
func total = (out int) {
    var int sum = 0
    for v of triple() {
        sum = sum + v
    }
    return sum
}
Console.write("\\{total()}")
`);
});
