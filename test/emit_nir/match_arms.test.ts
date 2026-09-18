// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("match arms emit NIR-natively byte-identically", () => {
	expect_byte_identical(`
func describe = (int x, out string) {
    var string label = "other"
    match x {
        case 1 -> label = "one"
        case 2 -> label = "two"
        else -> label = "many"
    }
    return label
}
Console.write("\\{describe(1)} \\{describe(5)}")
`);
});
