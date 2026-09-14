import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Trait dispatch through container elements. Two pre-existing holes:
//  - C emitted `&` of a class-typed receiver EXPRESSION (`.at(i)` already
//    yields the element pointer): `HeadingC_test(&Array_HeadingC_at(...))` —
//    clang rejects `&` of an rvalue. build_vtable_target and the direct-call
//    receiver path now pass a class-typed expression through as-is.
//  - aarch64 reclaimed a BORROWED trait slot's old value on reassignment
//    (the container still owns the element) → the next `.at(0)` was
//    use-after-free. The aarch64 trait-class reassignment now gates on the
//    anchor (owns_current); the C declaration registers borrowed trait slots
//    with a runtime owns-flag so a later store of a fresh instance is
//    reclaimed at scope exit (leak-free, conditional-store-safe).

const PRELUDE = `trait Rule {
	func test = (self, string line, out bool)
}
class HeadingC : Rule {
	pub func test = (self, string line, out bool) {
		return line.at_or(0, ' ') == '#'
	}
}
struct HeadingV : Rule {
	pub func test = (self, string line, out bool) {
		return line.at_or(0, ' ') == '#'
	}
}
`;

describe("trait dispatch through container elements", () => {
	test("method call on a container element receiver (both backends)", async () => {
		const input =
			PRELUDE +
			`
func test = () {
	var Array<HeadingC> rules = [HeadingC()]
	if rules.at(0).test("# h") {
		Console.write_line("heading")
	}
}
test()
Console.write_line("done")
`;
		await build_and_check_output(input, "trait_elem_dispatch", "heading\ndone");
	});

	test("borrowed trait slot used, container element still valid", async () => {
		const input =
			PRELUDE +
			`
func test = () {
	var Array<HeadingC> rules = [HeadingC()]
	var Rule p = rules.at(0)
	if p.test("# h") {
		Console.write_line("p-ok")
	}
	if rules.at(0).test("# h") {
		Console.write_line("elem-ok")
	}
}
test()
Console.write_line("done")
`;
		await build_and_check_output(input, "trait_borrow_use", "p-ok\nelem-ok\ndone");
	});

	test("reassigning a borrowed trait slot keeps the container element alive", async () => {
		const input =
			PRELUDE +
			`
func test = () {
	var Array<HeadingC> rules = [HeadingC()]
	var Rule p = rules.at(0)
	p = HeadingC()
	if rules.at(0).test("# h") {
		Console.write_line("elem-ok")
	}
	if p.test("# h") {
		Console.write_line("p-ok")
	}
}
test()
Console.write_line("done")
`;
		await build_and_check_output(input, "trait_borrow_reassign", "elem-ok\np-ok\ndone");
	});

	test("repeated stores into the borrowed slot reclaim cleanly (audit)", async () => {
		const input =
			PRELUDE +
			`
func test = () {
	var Array<HeadingC> rules = [HeadingC()]
	var Rule p = rules.at(0)
	var int i = 0
	while i < 3 {
		p = HeadingC()
		i = i + 1
	}
	if p.test("# h") {
		Console.write_line("p-ok")
	}
	if rules.at(0).test("# h") {
		Console.write_line("elem-ok")
	}
}
test()
Console.write_line("done")
`;
		await build_and_check_output(input, "trait_borrow_loop", "p-ok\nelem-ok\ndone");
	});

	test("value-struct-backed trait local dispatch still takes its address", async () => {
		const input =
			PRELUDE +
			`
func test = () {
	var Rule r = HeadingV()
	if r.test("# h") {
		Console.write_line("v-ok")
	}
}
test()
Console.write_line("done")
`;
		await build_and_check_output(input, "trait_vstruct_dispatch", "v-ok\ndone");
	});
});
