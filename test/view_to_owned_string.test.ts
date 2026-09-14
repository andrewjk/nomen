import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

const ERR =
	"cannot pass a 'view string' to string parameter 's' — call .to_string() to materialize an owned copy";

// A `view string` (a (ptr, len) borrow) cannot cross into an owned `string`
// parameter: the callee expects a heap-owned pair it may free or return. The
// backends used to diverge (aarch64 silently aliased the borrow; C failed to
// compile — `passing 'nomen_view' to parameter of incompatible type
// 'nomen_string'`). The checker now rejects the call and points at
// `.to_string()`, the explicit materialization used at the other boundaries
// (assignment / declaration / return).

function errors(source: string) {
	return parse_with_imports(source).errors.map((e) => e.message);
}

describe("view string -> owned string parameter", () => {
	test("named view local is rejected", () => {
		const input = `
func use_owned = (string s, out string) {
	return s
}
func test = () {
	var string text = "alpha bravo"
	const view string v = text.slice(0, 5)
	Console.write_line(use_owned(v))
}
test()
`;
		expect(errors(input)).toEqual([ERR]);
	});

	test("inline slice expression is rejected", () => {
		const input = `
func use_owned = (string s, out string) {
	return s
}
func test = () {
	var string text = "alpha bravo"
	Console.write_line(use_owned(text.slice(0, 5)))
}
test()
`;
		expect(errors(input)).toEqual([ERR]);
	});

	test("method parameter is rejected", () => {
		const input = `
class Echo {
	func echo = (self, string s, out string) {
		return s
	}
}
func test = () {
	var string text = "alpha bravo"
	const view string v = text.slice(0, 5)
	const e = Echo()
	Console.write_line(e.echo(v))
}
test()
`;
		expect(errors(input)).toEqual([ERR]);
	});

	test("constructor field argument is rejected", () => {
		const input = `
class Holder {
	var string text
}
func test = () {
	var string text = "alpha bravo"
	const view string v = text.slice(0, 5)
	const h = Holder(v)
	Console.write_line(h.text)
}
test()
`;
		expect(errors(input)).toEqual([
			"cannot pass a 'view string' to string parameter 'text' — call .to_string() to materialize an owned copy",
		]);
	});

	test("materialized view runs on both backends", async () => {
		const input = `
func use_owned = (string s, out string) {
	return s
}
func test = () {
	var string text = "alpha bravo"
	const view string v = text.slice(0, 5)
	Console.write_line(use_owned(v.to_string()))
	Console.write_line(use_owned(text.slice(6, 11).to_string()))
}
test()
`;
		await build_and_check_output(input, "view_to_owned_materialized", "alpha\nbravo");
	});

	test("owned string -> view string parameter stays the implicit borrow", async () => {
		const input = `
func show_view = (view string v, out string) {
	return v.to_string()
}
func test = () {
	var string text = "alpha bravo"
	Console.write_line(show_view(text))
	Console.write_line(show_view(text.slice(6, 11)))
}
test()
`;
		await build_and_check_output(input, "view_to_owned_reverse_ok", "alpha bravo\nbravo");
	});
});
