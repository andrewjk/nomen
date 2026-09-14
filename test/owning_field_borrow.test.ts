import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Owning (`move`) class fields take ownership of their instance. Storing a
// borrowed reference (a plain variable/param that is not itself a `move`
// transfer) lets the field's destroy free an instance its real owner frees
// too — a double free on both backends (FOLLOWUP "Enum-with-string-payload
// ownership edges", sub-item 1). The checker rejects the borrow; the sound
// owning-mutator idiom (`move` param consumed into the field) stays legal.

describe("owning class field stores", () => {
	test("move-param mutator consumed into the field runs (both backends)", async () => {
		const input = `
class Art {
	var int v
}
class Holder {
	move Art art
	func set_owned = (ref self, move Art a) {
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
class Art {
	var int v
}
class Holder {
	move Art art
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
class Art {
	var int v
}
class Holder {
	move Art art
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
		expect(parsed.errors.some((e) => e.message.includes("owning field 'art'"))).toBe(true);
	});

	test("owned local transfers into the field implicitly (both backends)", async () => {
		// The established corpus idiom (`var TreeNode l = create_tree(...);
		// node.left = l`): the local owns the instance and the backends
		// implicitly move it into the field, suppressing the local's cleanup.
		const input = `
class Art {
	var int v
}
class Holder {
	move Art art
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

	test("borrowed container element stored into the field is rejected", () => {
		const input = `
class Art {
	var int v
}
class Holder {
	move Art art
}
func test = () {
	var Array<Art> arts = [Art(1)]
	var Art borrowed = arts.at(0)
	var Holder h = Holder(Art(2))
	h.art = borrowed
}
test()
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("owning field 'art'"))).toBe(true);
	});

	test("null into a nullable owning field stays legal (both backends)", async () => {
		const input = `
class Box {
	var int v
}
class Holder {
	move Box? maybe
	func reset = (ref self) {
		self.maybe = null
	}
}
func test = () {
	var Holder h = Holder(move Box(5))
	h.reset()
}
test()
Console.write_line("done")
`;
		await build_and_check_output(input, "owning_field_null_ok", "done");
	});
});
