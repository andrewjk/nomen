// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("assignment swaps marshal through the NIR seam byte-identically", () => {
	// Tranche 5: the swap replacement (`a = b swap <rep>`) is a value
	// emission inside the swap marshalling, for both variable-RHS and
	// field-RHS swap shapes.
	expect_byte_identical(`
class Box {
  var int value
}
class Holder {
  move Box content
}
func run_swap_var = (out int) {
  var Box a = Box(1)
  var Box b = Box(2)
  a = b swap Box(7)
  return a.value * 10 + b.value
}
func run_swap_field = (out int) {
  var Holder h1 = Holder(move Box(1))
  var Holder h2 = Holder(move Box(2))
  h1.content = h2.content swap Box(99)
  return h1.content.value * 100 + h2.content.value
}
Console.write("\\{run_swap_var()} \\{run_swap_field()}")
`);
});
