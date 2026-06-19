import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Runtime string concatenation. Literal + literal is constant-folded, but
// concatenation involving variables or function results must run at runtime.

describe("string concat runtime", () => {
	test("concat variable with literal", async () => {
		const input = `
var string s = "hello"
var string r = s + " world"
Console.write(r)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("concat_var_literal", result, "hello world");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("concat_two_calls", result, "AC");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("concat_loop", result, "ababababab");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("concat_chained", result, "xAyB");
	});
});
