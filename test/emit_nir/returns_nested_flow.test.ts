// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("returns from nested flow arms emit NIR-natively", () => {
	expect_byte_identical(`
func first_hit = (int limit, out int) {
    var int i = 0
    while i < limit {
        if i * i > 20 {
            return i
        }
        i = i + 1
    }
    return 0
}
func scan_up = (int n, out int) {
    for i of 0 .. n {
        if i > 3 {
            return i * 10
        }
    }
    return 0
}
Console.write("\\{first_hit(10)} \\{scan_up(2)} \\{scan_up(9)}")
`);
});
