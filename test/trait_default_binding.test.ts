import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { compile_main, compile_module } from "./spec/_helpers.ts";

// The derive migration (the Comptime II backlog item): `Stringable` /
// `Equatable` / `Hashable` carry their derivations as `#for`-based
// reflection default bodies (`META.info(#self).fields`), and conformance
// without a hand-written method binds the default per conformer. The
// hardcoded checker synthesis is gone.

test("attribute-configured derives: @hash_ignore skips a field", () => {
	const body = `
		@label("point")
		mv struct Pt: Hashable {
			var int x
			@hash_ignore
			var int noise
		}
		func f = () {
			#for field of META.info(Pt).fields {
				if field.has_attr("hash_ignore") {
					Console.write_line(field.name + " skipped")
				}
			}
		}
	`;
	expect(compile_module(body)).toEqual([]);
});

test("the Hashable default dispatches scalars to uint casts, structs to .hash()", () => {
	const body = `
		mv struct Inner: Hashable {
			var int v
		}
		mv struct Outer: Hashable {
			var int n
			var bool flag
			var char code
			var string name
			var Inner inner
		}
		pub func main = () {
			var a = Outer(1, true, 'x', "hi", Inner(7))
			var b = Outer(1, true, 'x', "hi", Inner(7))
			var c = Outer(2, true, 'x', "hi", Inner(7))
			Console.write_line("\\{a.hash() == b.hash()}")
			Console.write_line("\\{a.hash() != c.hash()}")
		}
	`;
	expect(compile_main(body)).toEqual([]);
});

test("@hash_ignore keeps an identity-only field out of the hash", async () => {
	await build_and_check_output(
		`
import System

mv struct Token: Hashable {
	var int kind
	@hash_ignore
	var string scratch
}
pub func main = () {
	var a = Token(3, "first")
	var b = Token(3, "second")
	var c = Token(4, "first")
	Console.write_line("\\{a.hash() == b.hash()}")
	Console.write_line("\\{a.hash() != c.hash()}")
}
`,
		"derive_hash_ignore",
		"true\ntrue\n",
		true,
		{ js: true },
	);
});

test("a non-derivable Stringable field is a per-field error, not a silent skip", () => {
	const errors = compile_module(`
		mv struct Holder: Stringable {
			var items = StableList<int>()
		}
		func f = () {
			var h = Holder()
			var s = h.to_string()
		}
	`);
	expect(errors.some((e) => e.message.includes("to_string"))).toBe(true);
});

test("a non-hashable field errors through the default body", () => {
	const errors = compile_module(`
		mv struct Weak: Hashable {
			var float ratio
		}
		func f = () {
			var w = Weak(1.0)
			var h = w.hash()
		}
	`);
	expect(errors.some((e) => e.message.includes("hash"))).toBe(true);
});
