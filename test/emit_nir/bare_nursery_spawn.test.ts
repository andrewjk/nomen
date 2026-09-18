// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("bare nursery-spawn statements stay fire-and-forget through the NIR eval seam", () => {
	// The delegated path stamps is_statement on a nursery-spawn statement via
	// build_node's with_semicolon side effect; the eval arm must replicate it
	// or the spawn would emit a joined (waited) task instead of fire-and-forget
	// — an observable output difference this byte-identity test would catch.
	expect_byte_identical(`
func work = (uint64 id) {
    Console.write_line("ok")
}
async nursery {
    nursery.start(Thread(work(1)))
    var t = nursery.start(Thread(work(2)))
    t.wait()
}
`);
});
