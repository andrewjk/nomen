import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("mv-swap in function call args", () => {
	test("mv field with swap into struct constructor", async () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var Box content
}
var Holder h1 = Holder(mv Box(42))
var Holder h2 = Holder(mv h1.content swap Box(0))
Console.write("\\{h1.content.value} \\{h2.content.value}")
`;
		await build_and_check_output(input, "mov_swap_constructor", "0 42");
	});

	test("mv field with swap into function call", async () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var Box content
}
func take = (mv Box b) {
	Console.write("\\{b.value}")
}
var Holder h = Holder(mv Box(99))
take(mv h.content swap Box(0))
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
mv struct Holder<T> {
	var Buffer<T> buf = Buffer<T>()
	pub func take = (ref self, out Buffer<T>) {
		var Buffer<T> old = mv self.buf swap Buffer<T>()
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

	test("swap without mv is an error", () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var Box content
}
func take = (mv Box b) {
}
var Holder h = Holder(mv Box(42))
take(h.content swap Box(0))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("swap requires mv"),
		);
	});

	test("swap type mismatch is an error", () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var Box content
}
func take = (mv Box b) {
}
var Holder h = Holder(mv Box(42))
take(mv h.content swap 99)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("mv field with swap no leak", async () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var Box content
}
var Holder h1 = Holder(mv Box(1))
var Holder h2 = Holder(mv Box(2))
h2 = Holder(mv h1.content swap Box(3))
Console.write("done")
`;
		await build_and_check_output(input, "mov_swap_no_leak", "done");
	});
});

// D3: `mv ... swap ""` on a `string` — the source's owned pair transfers to
// the binding and the source is revalidated with the empty replacement. Both
// backends audited clean (previously the C declaration leaked the moved pair
// and the mv struct's destroy freed the rodata replacement).
describe("mv-swap on strings", () => {
	test("plain variable mv+swap transfers and revalidates", async () => {
		const input = `
var string a = 42.to_string()
var string b = mv a swap ""
Console.write("\\{b}|\\{a}|end")
`;
		await build_and_check_output(input, "mov_swap_string_plain", "42||end");
	});

	test("mv struct string field mv+swap revalidates the field", async () => {
		const input = `
mv struct Person {
	var string name
	var int age
}
var p = Person("Ada", 30)
var s = mv p.name swap ""
Console.write("\\{s}|\\{p.name}|\\{p.age}")
`;
		await build_and_check_output(input, "mov_swap_string_field", "Ada||30");
	});

	test("mv-destructuring a string field revalidates the source", async () => {
		const input = `
mv struct Person {
	var string name
	var int age
}
var p = Person("Ada", 30)
var [mv name, age] = p
Console.write("\\{name}|\\{p.name}|\\{age}")
`;
		await build_and_check_output(input, "mov_swap_string_destructure", "Ada||30");
	});

	// A `mv`-destructured STRING field off a DESTRUCTURE TEMP (a shallow copy
	// of unknown provenance — a literal-seeded variadic slot) lowers as the
	// borrow copy: an owning binding would free rodata (AUDIT-STALE-FREE).
	// The callee materializes its own copy; the slot's owner reclaims heap
	// bytes. This is the shape Map's variadic pairs init rides.
	test("mv-destructuring a string field off a temp borrows, audit-clean", async () => {
		const input = `
func take = (mv string s) {
	Console.write("\\{s}\\n")
}
func f = (...[string, string] pairs) {
	var i = 0
	while i < pairs.length; i += 1 {
		var [mv k, mv v] = pairs.at(i)
		take(mv k)
		take(mv v)
	}
}
f(["a", "b"], ["c", "d"])
`;
		await build_and_check_output(input, "mov_swap_string_destructure_temp", "a\nb\nc\nd\n");
	});
});
