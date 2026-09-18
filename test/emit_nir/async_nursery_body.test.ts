// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("async nursery body dispatches NIR-natively (nested flow inside the cursor)", () => {
	// The async_block dispatch arm hands build_async_block_node the lowered
	// body, whose block installs its own cursor — an if inside the nursery
	// now dispatches NIR-natively instead of riding the AST walk.
	expect_byte_identical(`
func probe = (int v, out int) {
    return v + 1
}
func nursery_flow = (out int) {
    var int total = 0
    async(timeout: 2000) {
        Thread(probe(1)).start()
        if total == 0 {
            total = total + 40
        }
    }
    return total
}
Console.write("\\{nursery_flow()}")
`);
});
