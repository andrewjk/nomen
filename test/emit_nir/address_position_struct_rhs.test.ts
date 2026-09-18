// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("address-position struct RHS emits through the NIR seam byte-identically", () => {
	// Tranche 5: get_source_address with a non-name RHS is a VALUE emission in
	// address position (a struct-typed RHS builds to an ADDRESS in x0) — it
	// now descends the expression seam; plain names keep their slot/param-reg
	// resolution on the AST path.
	expect_byte_identical(`
struct Pt {
  var int x
  var int y
}
func mk = (int a, out Pt) {
  return Pt(a, a + 1)
}
func run_addr = (out int) {
  var Pt p = Pt(0, 0)
  p = mk(3)
  return p.x + p.y
}
Console.write("\\{run_addr()}")
`);
});
