// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

test("NIR-native swap and address-RHS binaries run correctly", async () => {
	// Behavioral belt-and-braces for the tranche-5 paths: p = mk(3) → (3,4)
	// → 7; a = b swap Box(7) → a=2, b=7 → 27; h1.content = h2.content swap
	// Box(99) → h1=2, h2=99 → 299; var Pt c = move w.pt swap Pt(5,5) → c.x=4,
	// w.pt.x=5 → 45.
	const { default: build_and_check_output } = await import("../build_and_check_output");
	await build_and_check_output(
		`
struct Pt {
  var int x
  var int y
}
struct Wrap {
  var Pt pt
}
class Box {
  var int value
}
class Holder {
  move Box content
}
func mk = (int a, out Pt) {
  return Pt(a, a + 1)
}
func run_addr = (out int) {
  var Pt p = Pt(0, 0)
  p = mk(3)
  return p.x + p.y
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
func run_decl = (out int) {
  var Wrap w = Wrap(Pt(4, 4))
  var Pt c = move w.pt swap Pt(5, 5)
  return c.x * 10 + w.pt.x
}
Console.write("\\{run_addr()} \\{run_swap_var()} \\{run_swap_field()} \\{run_decl()}")
`,
		"emit_nir_swap_addr",
		"7 27 299 45",
	);
});
