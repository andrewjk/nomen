import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Runtime string repetition: "abc" * int.
// Literal * literal is constant-folded by build_declaration_node, but
// repeat with a variable count (or computed count) must run at runtime.
// Currently emits `mul x0, x1, x2` (integer multiply) → garbage pointer.

describe("string repeat runtime", () => {
	test("repeat variable with int variable count", async () => {
		const input = `
var string s = "ab"
var int n = 4
var string r = s * n
Console.write(r)
`;
		await build_and_check_output(input, "repeat_int_var", "abababab");
	});

	test("repeat with computed count", async () => {
		const input = `
var string s = "xyz"
var int a = 1
var int b = 2
var string r = s * (a + b)
Console.write(r)
`;
		await build_and_check_output(input, "repeat_computed", "xyzxyzxyz");
	});

	test("repeat reassigned in a loop", async () => {
		const input = `
var string s = ""
var int j = 0
while j < 3 {
	var string piece = "x" * (j + 1)
	s = s + piece
	j = j + 1
}
Console.write(s)
`;
		await build_and_check_output(input, "repeat_loop", "xxxxxx");
	});

	test("repeat result used in concat", async () => {
		const input = `
var string s = "a"
var int n = 3
var string r = s * n + "!"
Console.write(r)
`;
		await build_and_check_output(input, "repeat_concat", "aaa!");
	});
});
