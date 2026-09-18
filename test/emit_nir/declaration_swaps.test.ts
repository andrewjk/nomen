// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("declaration swaps marshal through the NIR seam byte-identically", () => {
	// Tranche 5: `var Pt c = move w.pt swap <rep>` — the value-struct
	// declaration path's swap replacement rides the seam too.
	expect_byte_identical(`
struct Pt {
  var int x
  var int y
}
struct Wrap {
  var Pt pt
}
func run_decl = (out int) {
  var Wrap w = Wrap(Pt(4, 4))
  var Pt c = move w.pt swap Pt(5, 5)
  return c.x * 10 + w.pt.x
}
Console.write("\\{run_decl()}")
`);
});
