import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Regression: a nested field write through a CLASS-typed field (`a.x.s = …`)
// must dereference the intermediate pointer, not target the pointer slot.
// aarch64 computed the base as `&a->x` (the slot) and stored past the field;
// C stored a rodata literal into the always-heap class string field and then
// `<Class>_destroy` freed it (invalid free).
describe("nested write through a class-typed field", () => {
	test("string literal assigned into a move-class field", async () => {
		const input = `
class Inner { var s = "" }
class A { move x = Inner() }

var a = A()
a.x.s = "value one"
Console.write_line(a.x.s)
`;
		await build_and_check_output(input, "nested_class_field_string_literal", "value one\n");
	});

	test("heap string assigned into a move-class field", async () => {
		const input = `
class Inner { var s = "" }
class A { move x = Inner() }

var a = A()
a.x.s = 42.to_string()
Console.write_line(a.x.s)
`;
		await build_and_check_output(input, "nested_class_field_string_heap", "42\n");
	});

	test("int field through a move-class field", async () => {
		const input = `
class Inner { var n = 0 }
class A { move x = Inner() }

var a = A()
a.x.n = 42
Console.write_line(a.x.n.to_string())
`;
		await build_and_check_output(input, "nested_class_field_int", "42\n");
	});

	test("string field two class hops deep", async () => {
		const input = `
class Deep { var s = "" }
class Mid { move d = Deep() }
class A { move m = Mid() }

var a = A()
a.m.d.s = "hi"
Console.write_line(a.m.d.s)
`;
		await build_and_check_output(input, "nested_class_field_two_hops", "hi\n");
	});

	test("value struct nested inside a class field", async () => {
		const input = `
struct Point { var x = 0 }
class Holder { var p = Point() }

var h = Holder()
h.p.x = 7
Console.write_line(h.p.x.to_string())
`;
		await build_and_check_output(input, "nested_class_field_value_struct", "7\n");
	});
});
