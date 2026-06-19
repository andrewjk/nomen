import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("repeat_int_var", result, "abababab");
	});

	test("repeat with computed count", async () => {
		const input = `
var string s = "xyz"
var int a = 1
var int b = 2
var string r = s * (a + b)
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("repeat_computed", result, "xyzxyzxyz");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("repeat_loop", result, "xxxxxx");
	});

	test("repeat result used in concat", async () => {
		const input = `
var string s = "a"
var int n = 3
var string r = s * n + "!"
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("repeat_concat", result, "aaa!");
	});
});
