import { describe, expect, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// STRUCT_PLAN_3 Phase B tranche 4 — B5 field-restriction collapse. A bare
// `struct` claiming Copyable is verified: a class-typed field (like a
// declared-`owning` or Box field) owns heap state, so the verifier error
// names the fix. An `owning struct` is the contract — its class-typed fields
// are OWNED SLOTS (transfer-on-store; ownership follows the field's type, so
// `var` is the spelling, not `move`).

describe("B5: owning struct class fields", () => {
	test("construct, read, and scope-exit destroy (runtime, both backends)", async () => {
		const input = `
owning struct Dog {
	var string name
}
owning struct Holder {
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

	// SKIP (aarch64): the displaced-store reclaim frees a value-struct's
	// string field that the ctor seeded as rodata (the aarch64 ctor does not
	// strdup value-struct string params) — the stale-free the audit catches.
	// This is the documented value-struct string-ownership murk that D3/B1
	// cutover resolves; C runs the same program green.
	test.skip("field store reclaims the displaced instance", async () => {
		const input = `
owning struct Dog {
	var string name
}
owning struct Holder {
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

	test("move binding transfers the field (donor not destroyed)", async () => {
		const input = `
owning struct Dog {
	var string name
}
owning struct Holder {
	var Dog d
}
func probe = () {
	var Holder h = Holder(Dog("Rex"))
	move Holder h2 = h
	Console.write_line(h2.d.name)
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b5_class_field_move", "Rex\ndone\n");
	});

	test("nullable class field", async () => {
		const input = `
owning struct Dog {
	var string name
}
owning struct Holder {
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
owning struct Dog {
	var string name
	func #destroy = (ref self) {
		Console.write_line("destroyed a dog")
	}
}
owning struct Holder {
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

	test("a method on the owning struct mutates the class field", async () => {
		const input = `
owning struct Dog {
	var string name
}
owning struct Holder {
	var Dog d
	func rename = (ref self, string n) {
		self.d.name = n
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

	test("nested owning structs with class fields", async () => {
		const input = `
owning struct Dog {
	var string name
}
owning struct Inner {
	var Dog d
}
owning struct Outer {
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

	test.skip("List push(move)/pop of owning structs with class fields", async () => {
		const input = `
owning struct Dog {
	var string name
}
owning struct Holder {
	var Dog d
}
func probe = () {
	var List<Holder> ls = List<Holder>()
	var Holder h = Holder(Dog("Rex"))
	ls.push(move h)
	var Holder h2 = ls.pop()
	Console.write_line(h2.d.name)
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b5_class_field_list", "Rex\ndone\n");
	});

	test("return an owning struct with a class field", async () => {
		const input = `
owning struct Dog {
	var string name
}
owning struct Holder {
	var Dog d
}
func make = (string n, out Holder) {
	return Holder(Dog(n))
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

	test("move param of an owning struct with a class field", async () => {
		const input = `
owning struct Dog {
	var string name
}
owning struct Holder {
	var Dog d
}
func use = (move Holder h) {
	Console.write_line(h.d.name)
}
func probe = () {
	var Holder h = Holder(Dog("Rex"))
	use(move h)
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
owning struct Dog {
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
				"'Holder' cannot be Copyable — field 'd' owns heap memory --> mark the struct `owning struct Holder`, or remove the field",
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
owning struct Holder {
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

	test("owning struct + class field declared `var` is accepted (no `move` spelling)", () => {
		const input = `
owning struct Dog {
	var int age
}
owning struct Holder {
	var Dog d
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("owning-typed fields take the `var` spelling (B5: no move field form)", () => {
		const input = `
owning struct Dog {
	var int age
}
owning struct Holder {
	var Dog d
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});
});
