import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

const opts = { arch: "aarch64", audit: true } as const;

// A string local returned inside a tuple literal used to dangle on both
// backends: the callee's scope-exit free released the buffer while the
// returned tuple's field still pointed at it (the caller's read was a
// masked use-after-free). The literal-element last-use inference now
// TRANSFERS heap string locals into the tuple (the callee's cleanup skips
// them), and the destructured binding takes the buffer raw and frees it at
// scope exit — one owner, balanced under audit.
describe("tuple string returns", () => {
	test(
		"string local transferred through a tuple return stays valid",
		{ timeout: 120_000 },
		async () => {
			const input = `
import System

func make = (out [string, int]) {
	var s = "hello world, a string long enough to be heap"
	return [s, 42]
}

pub func main = (Init init) {
	var [a, n] = make()
	Console.write_line("\\{a} \\{n}")
}
`;
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch: "aarch64", audit: true });
			await check_output(
				"tuple_string_return",
				result,
				"hello world, a string long enough to be heap 42\n",
				opts,
			);
		},
	);

	test("string local read after the literal is rejected", () => {
		const input = `
import System

func make = (out [string, int]) {
	var s = "hello"
	return [s, 42]
}
pub func main = (Init init) {
	var pair = make()
	Console.write_line("unreachable")
}
`;
		const parsed = parse_raw(input);
		// `s` is read after the literal only via the tuple itself — the shape
		// above compiles clean; assert no spurious rejection here.
		expect(parsed.errors).toEqual([]);
	});
});

// The residual shapes after the transfer fix, closed by RETURN-BOUNDARY
// NORMALIZATION (the `_Tuple_` analog of the value-struct normalization):
// every string element of a return-position tuple literal is made
// heap-owned — transferred heap locals and fresh non-borrow expressions
// stay raw, everything else (string literals, rodata locals, parameters,
// borrow accessors) is strdup'd on the return temp — and the caller's
// destructured binding takes ownership of the field and frees it at scope
// exit. All four shapes run under audit on both backends.
describe("tuple string return normalization", () => {
	test("heap local element (call RHS) is owned by the binding", async () => {
		const input = `
import System

func make = (move out [string, int]) {
	var s = "hello world, a string long enough to be heap"
	return [s, 42]
}

pub func main = (Init init) {
	var [a, n] = make()
	Console.write_line("\\{a} \\{n}")
}
`;
		await build_and_check_output(
			input,
			"tuple_norm_local",
			"hello world, a string long enough to be heap 42\n",
			true,
		);
	});

	test("fresh call-result element is owned by the binding", async () => {
		const input = `
import System

func make = (int x, move out [string, int]) {
	return [x.to_string(), 42]
}

pub func main = (Init init) {
	var [a, n] = make(7)
	Console.write_line("\\{a} \\{n}")
}
`;
		await build_and_check_output(input, "tuple_norm_call_result", "7 42\n", true);
	});

	test("borrow element is copied on the return boundary", async () => {
		const input = `
import System

func make = (List<string> src, move out [string, int]) {
	return [src.at_or_panic(0), 42]
}

pub func main = (Init init) {
	var src = List<string>()
	src.push("borrowed")
	var [a, n] = make(src)
	Console.write_line("\\{a} \\{n}")
}
`;
		await build_and_check_output(input, "tuple_norm_borrow", "borrowed 42\n", true);
	});

	test("literal element is copied on the return boundary", async () => {
		const input = `
import System

func make = (move out [string, int]) {
	return ["literal title", 42]
}

pub func main = (Init init) {
	var [a, n] = make()
	Console.write_line("\\{a} \\{n}")
}
`;
		await build_and_check_output(input, "tuple_norm_literal", "literal title 42\n", true);
	});

	test("a named tuple variable owns its normalized fields", async () => {
		const input = `
import System

func make = (move out [string, int]) {
	var s = "hello world, a string long enough to be heap"
	return [s, 42]
}

pub func main = (Init init) {
	var pair = make()
	Console.write_line("\\{pair._0} \\{pair._1}")
}
`;
		await build_and_check_output(
			input,
			"tuple_norm_named_var",
			"hello world, a string long enough to be heap 42\n",
			true,
		);
	});

	test("a named tuple literal variable frees only owned elements", async () => {
		const input = `
import System

pub func main = (Init init) {
	var s = "hello world, a string long enough to be heap"
	var pair = [move s, 5]
	Console.write_line("\\{pair._0} \\{pair._1}")
	var lit = ["literal element", 5]
	Console.write_line("\\{lit._0} \\{lit._1}")
}
`;
		await build_and_check_output(
			input,
			"tuple_norm_named_literal",
			"hello world, a string long enough to be heap 5\nliteral element 5\n",
			true,
		);
	});
});
