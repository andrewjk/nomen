// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("flow-shaped nesting (match in for, for in match) emits NIR-natively", () => {
	expect_byte_identical(`
func nested_flow = (int n, out int) {
    var int acc = 0
    for i of 0 .. n {
        match i % 3 {
            case 0 -> acc = acc + 10
            case 1 {
                var int j = 0
                while j < i {
                    acc = acc + 1
                    j = j + 1
                }
            }
            else -> acc = acc + 1
        }
    }
    return acc
}
Console.write("\\{nested_flow(6)}")
`);
});
