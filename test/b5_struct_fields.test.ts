import { describe, expect, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// STRUCT_PLAN_3 Phase B tranche 4 — B5 field-restriction collapse. A bare
// `struct` claiming Copyable is verified: a class-typed field (like a
// declared-`mv` or Box field) owns heap state, so the verifier error
// names the fix. A `mv struct` is the contract — its class-typed fields
// are OWNED SLOTS (transfer-on-store; ownership follows the field's type, so
// `var` is the spelling, not `mv`).

describe("B5: mv struct class fields", () => {
	test("construct, read, and scope-exit destroy (runtime, both backends)", async () => {
		const input = `
mv struct Dog {
	var string name
}
mv struct Holder {
	var Dog d
}
func probe = () {
	var Holder h = Holder(Dog("Rex"))
	Console.write_line(h.d.name)
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b5_class_field_basic", "Rex\ndone\n");
	});

	// Landed with the B1 backend cutover: the ctor strdups string params on
	// both backends and the displaced-store reclaim frees the instance.
	test("field store reclaims the displaced instance", async () => {
		const input = `
mv struct Dog {
	var string name
}
mv struct Holder {
	var Dog d
}
func probe = () {
	var Holder h = Holder(Dog("Rex"))
	h.d = Dog("Fido")
	Console.write_line(h.d.name)
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b5_class_field_store", "Fido\ndone\n");
	});

	test("mv binding transfers the field (donor not destroyed)", async () => {
		const input = `
mv struct Dog {
	var string name
}
mv struct Holder {
	var Dog d
}
func probe = () {
	var Holder h = Holder(Dog("Rex"))
	mv Holder h2 = h
	Console.write_line(h2.d.name)
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b5_class_field_move", "Rex\ndone\n");
	});

	test("nullable class field", async () => {
		const input = `
mv struct Dog {
	var string name
}
mv struct Holder {
	var Dog? d
}
func probe = () {
	var Holder h = Holder(Dog("Rex"))
	Console.write_line(h.d.name)
	h.d = Dog("Fido")
	Console.write_line(h.d.name)
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b5_class_field_nullable", "Rex\nFido\ndone\n");
	});

	test("class field with a user #destroy runs it", async () => {
		const input = `
mv struct Dog {
	var string name
	func #destroy = (ref self) {
		Console.write_line("destroyed a dog")
	}
}
mv struct Holder {
	var Dog d
}
func probe = () {
	var Holder h = Holder(Dog("Rex"))
	Console.write_line("alive")
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(
			input,
			"b5_class_field_user_destroy",
			"alive\ndestroyed a dog\ndone\n",
		);
	});

	test("a method on the mv struct mutates the class field", async () => {
		const input = `
mv struct Dog {
	var string name
}
mv struct Holder {
	var Dog d
	func rename = (ref self, string n) {
		self.d.name = n.copy()
	}
}
func probe = () {
	var Holder h = Holder(Dog("Rex"))
	h.rename("Fido")
	Console.write_line(h.d.name)
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b5_class_field_method", "Fido\ndone\n");
	});

	test("nested mv structs with class fields", async () => {
		const input = `
mv struct Dog {
	var string name
}
mv struct Inner {
	var Dog d
}
mv struct Outer {
	var Inner inner
}
func probe = () {
	var Outer o = Outer(Inner(Dog("Rex")))
	Console.write_line(o.inner.d.name)
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b5_class_field_nested", "Rex\ndone\n");
	});

	test("List push(mv)/pop of mv structs with class fields", async () => {
		const input = `
mv struct Dog {
	var string name
}
mv struct Holder {
	var Dog d
}
func probe = () {
	var List<Holder> ls = List<Holder>()
	var Holder h = Holder(Dog("Rex"))
	ls.push(mv h)
	var Holder h2 = ls.pop()
	Console.write_line(h2.d.name)
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b5_class_field_list", "Rex\ndone\n");
	});

	test("return a mv struct with a class field", async () => {
		const input = `
mv struct Dog {
	var string name
}
mv struct Holder {
	var Dog d
}
func make = (string n, out Holder) {
	return Holder(Dog(n.copy()))
}
func probe = () {
	var Holder h = make("Rex")
	Console.write_line(h.d.name)
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b5_class_field_return", "Rex\ndone\n");
	});

	test("mv param of a mv struct with a class field", async () => {
		const input = `
mv struct Dog {
	var string name
}
mv struct Holder {
	var Dog d
}
func use = (mv Holder h) {
	Console.write_line(h.d.name)
}
func probe = () {
	var Holder h = Holder(Dog("Rex"))
	use(mv h)
	Console.write_line("moved")
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b5_class_field_move_param", "Rex\nmoved\ndone\n");
	});
});

describe("B5: verifier errors", () => {
	test("bare struct + class field is the Copyable verifier error", () => {
		const input = `
mv struct Dog {
	var int age
}
struct Holder {
	var Dog d
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"'Holder' cannot be Copyable — field 'd' owns heap memory --> mark the struct `mv struct Holder`, or remove the field",
				6,
				2,
			),
		]);
	});

	test("trait-typed fields are not supported yet (fix named)", () => {
		const input = `
trait Speaker {
	func say = (out string)
}
mv struct Holder {
	var Speaker s
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"a trait-typed field is not supported yet — declare 's' with the concrete type, or `Box<Speaker>` once boxed",
				6,
				2,
			),
		]);
	});

	test("mv struct + class field declared `var` is accepted (no `mv` spelling)", () => {
		const input = `
mv struct Dog {
	var int age
}
mv struct Holder {
	var Dog d
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("mv-typed fields take the `var` spelling (B5: no mv field form)", () => {
		const input = `
mv struct Dog {
	var int age
}
mv struct Holder {
	var Dog d
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});
});
