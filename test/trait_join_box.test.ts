import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// `return <join expression>` from a trait-returning function: the join's
// branches produce a CONCRETE value struct, so the generic join path handed
// the caller either a C type error (C: struct value assigned to the trait
// pointer slot) or a pointer into the dying callee frame (aarch64: the
// branch temp's stack address stored as the "handle" — EXC_BAD_ACCESS on
// the first dispatched call). Both backends now box the winner at the join
// point (same malloc + strdup contract as the direct-expression box branch).

test("switch, if, and match joins box the concrete conformer", async () => {
	await build_and_check_output(
		`
trait Shape {
	func area = (self, out int)
}
struct Square : Shape {
	var int side
	func area = (self, out int) {
		return self.side * self.side
	}
	pub func #init = (self, int s) {
		self.side = s
	}
}
func scaled = (int s, out Square) {
	return Square(s * 2)
}
func make_switch = (int k, out Shape) {
	return switch {
		case k == 0 -> Square(2)
	} else -> Square(3)
}
func make_if = (int k, out Shape) {
	return if k == 0 -> Square(4) else -> Square(5)
}
func make_match = (int k, out Shape) {
	return match k {
		case 0 -> scaled(3)
	} else -> scaled(4)
}
mv struct Label : Shape {
	var string text = ""
	func area = (self, out int) {
		return self.text.length
	}
	pub func #init = (self) {}
}
func make_label = (int k, out Shape) {
	return switch {
		case k == 0 -> Label()
	} else -> Label()
}
var Shape a = make_switch(0)
Console.write("\\{a.area()}")
var Shape b = make_switch(1)
Console.write("\\{b.area()}")
var Shape c = make_if(0)
Console.write("\\{c.area()}")
var Shape d = make_if(1)
Console.write("\\{d.area()}")
var Shape e = make_match(0)
Console.write("\\{e.area()}")
var Shape f = make_match(1)
Console.write("\\{f.area()}")
var Shape g = make_label(0)
Console.write("\\{g.area()}")
Console.write("|")
`,
		"trait_join_box",
		"49162536640|",
	);
});
