import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("move-swap in function call args", () => {
	test("move field with swap into struct constructor", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	move Box content
}
var Holder h1 = Holder(move Box(42))
var Holder h2 = Holder(move h1.content swap Box(0))
Console.write("\\{h1.content.value} \\{h2.content.value}")
`;
		await build_and_check_output(input, "mov_swap_constructor", "0 42");
	});

	test("move field with swap into function call", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	move Box content
}
func take = (move Box b) {
	Console.write("\\{b.value}")
}
var Holder h = Holder(move Box(99))
take(move h.content swap Box(0))
Console.write("\\{h.content.value}")
`;
		await build_and_check_output(input, "mov_swap_funcall", "990");
	});

	test("swap restores a struct field fully inside a generic method", async () => {
		// Regression: the swap-back used to copy only one 8-byte word of the
		// replacement because the AccessFieldNode's cached type still named the
		// generic template `Buffer<T>` (not the monomorphized `Buffer_int`), so
		// `cap` kept the swapped-out buffer's value and the two buffers aliased
		// their slab (double free).
		const input = `
struct Holder<T> {
	var Buffer<T> buf = Buffer<T>()
	pub func take = (ref self, out Buffer<T>) {
		var Buffer<T> old = move self.buf swap Buffer<T>()
		return old
	}
}
var Holder<int> h = Holder<int>()
h.buf.grow(8)
var Buffer<int> old = h.take()
Console.write("\\{h.buf.cap} \\{old.cap}")
`;
		await build_and_check_output(input, "mov_swap_generic_struct_field", "0 8");
	});

	test("swap without move is an error", () => {
		const input = `
class Box {
	var int value
}
class Holder {
	move Box content
}
func take = (move Box b) {
}
var Holder h = Holder(move Box(42))
take(h.content swap Box(0))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("swap requires move"),
		);
	});

	test("swap type mismatch is an error", () => {
		const input = `
class Box {
	var int value
}
class Holder {
	move Box content
}
func take = (move Box b) {
}
var Holder h = Holder(move Box(42))
take(move h.content swap 99)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("move field with swap no leak", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	move Box content
}
var Holder h1 = Holder(move Box(1))
var Holder h2 = Holder(move Box(2))
h2 = Holder(move h1.content swap Box(3))
Console.write("done")
`;
		await build_and_check_output(input, "mov_swap_no_leak", "done");
	});
});
