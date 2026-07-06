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
});
