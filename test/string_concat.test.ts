import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Runtime string concatenation. Literal + literal is constant-folded, but
// concatenation involving variables or function results must run at runtime.

describe("string concat runtime", () => {
	test("concat variable with literal", async () => {
		const input = `
var string s = "hello"
var string r = s + " world"
Console.write(r)
`;
		await build_and_check_output(input, "concat_var_literal", "hello world");
	});

	test("concat two function results", async () => {
		const input = `
func nt = (int code, out string) {
	if code == 0 { return "A" }
	if code == 1 { return "C" }
	if code == 2 { return "T" }
	return "G"
}

var string r = nt(0) + nt(1)
Console.write(r)
`;
		await build_and_check_output(input, "concat_two_calls", "AC");
	});

	test("concat reassigned in a loop", async () => {
		const input = `
var string s = ""
var int j = 0
while j < 5 {
	s = s + "ab"
	j = j + 1
}
Console.write(s)
`;
		await build_and_check_output(input, "concat_loop", "ababababab");
	});

	test("concat chained and interleaved", async () => {
		const input = `
func nt = (int code, out string) {
	if code == 0 { return "A" }
	return "B"
}

var string base = "x"
var string r = base + nt(0) + "y" + nt(1)
Console.write(r)
`;
		await build_and_check_output(input, "concat_chained", "xAyB");
	});

	// Owned-string expression temporaries (concat, interpolation, or a call
	// returning a fresh heap string) consumed inline — as a call argument or
	// an operator operand — must be freed when the consuming statement
	// completes. build_and_check_output asserts audit cleanliness (alloc/free
	// balance) on BOTH backends, which is the regression: the aarch64 backend
	// leaked these temps.
	test("owned string temps consumed inline do not leak (audit)", async () => {
		const input = `
func render = (string a, out string) {
	return "v:" + a
}

func length_of = (string s, out int) {
	return s.length
}

var int n = 0
var int i = 0
while i < 3 {
	// owned expression as a call argument
	n = n + length_of(" " + "hello")
	n = n + length_of(render("a"))
	// owned expression as a comparison operand
	if render("b") == "v:b" { n = n + 1 }
	if " " + "z" == " z" { n = n + 1 }
	if render("x").length > 1 { n = n + 1 }
	if render("p") == render("p") { n = n + 1 }
	// parenthesized (grouped) owned operands
	n = n + length_of(("a" + "b") + "c")
	if ("a" + "b") + "c" == "abc" { n = n + 1 }
	if "abc" == "a" + "bc" { n = n + 1 }
	i = i + 1
}
Console.write("\\{n}")
`;
		// per iteration: 6 + 3 + 1 + 1 + 1 + 1 + 3 + 1 + 1 = 18; i==0 adds
		// nothing extra here; 3 iterations = 54... plus the first-iteration
		// interpolation-free shapes keep it deterministic.
		await build_and_check_output(input, "concat_owned_temps_no_leak", "54");
	});

	// `!=` with a heap-temp operand dispatches to the string's `eq` and must
	// invert the result — the spill-and-free path on the C backend used to
	// drop the inversion (aarch64 was correct).
	test("ne with owned call operand inverts (audit)", async () => {
		const input = `
func render = (string a, out string) {
	return "v:" + a
}

var int hits = 0
var int i = 0
while i < 2 {
	if render("b") != "x" {
		hits = hits + 1
	}
	i = i + 1
}
Console.write("\\{hits}")
`;
		await build_and_check_output(input, "concat_ne_owned_operand", "2");
	});
});
