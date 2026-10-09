import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Owning (`mv`) class fields take ownership of their instance. Storing a
// borrowed reference (a plain variable/param that is not itself a `mv`
// transfer) lets the field's destroy free an instance its real owner frees
// too — a double free on both backends (FOLLOWUP "Enum-with-string-payload
// ownership edges", sub-item 1). The checker rejects the borrow; the sound
// mv-mutator idiom (`mv` param consumed into the field) stays legal.

describe("mv class field stores", () => {
	test("mv-param mutator consumed into the field runs (both backends)", async () => {
		const input = `
mv struct Art {
	var int v
}
mv struct Holder {
	var Art art
	func set_owned = (ref self, mv Art a) {
		self.art = a
	}
}
func test = () {
	var Holder h = Holder(Art(1))
	h.set_owned(Art(2))
	if h.art.v == 2 {
		Console.write_line("ok")
	}
}
test()
Console.write_line("done")
`;
		await build_and_check_output(input, "owning_field_mutator_ok", "ok\ndone");
	});

	test("fresh constructor store into the field runs (both backends)", async () => {
		const input = `
mv struct Art {
	var int v
}
mv struct Holder {
	var Art art
	func reset = (ref self) {
		self.art = Art(9)
	}
}
func test = () {
	var Holder h = Holder(Art(1))
	h.reset()
	if h.art.v == 9 {
		Console.write_line("reset")
	}
}
test()
Console.write_line("done")
`;
		await build_and_check_output(input, "owning_field_fresh_ok", "reset\ndone");
	});

	test("borrowed parameter stored into the field is rejected", () => {
		const input = `
mv struct Art {
	var int v
}
mv struct Holder {
	var Art art
	func set_borrowed = (ref self, Art a) {
		self.art = a
	}
}
func test = () {
	var Holder h = Holder(Art(1))
	h.set_borrowed(Art(2))
}
test()
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("mv field 'art'"))).toBe(true);
	});

	test("owned local transfers into the field implicitly (both backends)", async () => {
		// The established corpus idiom (`var TreeNode l = create_tree(...);
		// node.left = l`): the local owns the instance and the backends
		// implicitly mv it into the field, suppressing the local's cleanup.
		const input = `
mv struct Art {
	var int v
}
mv struct Holder {
	var Art art
}
func make = (int n, out Art) {
	return Art(n)
}
func test = () {
	var Art owned = make(2)
	var Holder h = Holder(Art(1))
	h.art = owned
	if h.art.v == 2 {
		Console.write_line("transferred")
	}
}
test()
Console.write_line("done")
`;
		await build_and_check_output(input, "owning_field_owned_local_ok", "transferred\ndone");
	});

	test("ref-parameter source stored into the field is rejected", () => {
		const input = `
mv struct Art {
	var int v
}
mv struct Holder {
	var Art art
	func set_ref = (ref self, ref Art a) {
		self.art = a
	}
}
func test = () {
	var Holder h = Holder(mv Art(2))
	var Art a = Art(3)
	h.set_ref(ref a)
}
test()
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("mv field 'art'"))).toBe(true);
	});

	test("null into a nullable mv field stays legal (both backends)", async () => {
		const input = `
mv struct Box {
	var int v
}
mv struct Holder {
	var Box? maybe
	func reset = (ref self) {
		self.maybe = null
	}
}
func test = () {
	var Holder h = Holder(Box(5))
	h.reset()
}
test()
Console.write_line("done")
`;
		await build_and_check_output(input, "owning_field_null_ok", "done");
	});
});
