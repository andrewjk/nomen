// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("for ref of array (writeback path) emits NIR-natively byte-identically", () => {
	expect_byte_identical(`
func zeroed = (out int) {
    var int[] nums = [7, 8, 9]
    for ref n of nums {
        n = n - 1
    }
    var int sum = 0
    for n of nums {
        sum = sum + n
    }
    return sum
}
Console.write("\\{zeroed()}")
`);
});
