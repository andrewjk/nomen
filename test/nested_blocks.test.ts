import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Bare nested blocks: `{ ... }` as a statement is a plain lexical scope.
// Deterministic destruction runs at the closing brace — the one-zero-cost
// way to release a mv value before the enclosing function ends (the honest
// form of the `if true { … }` workaround).

describe("bare nested blocks", () => {
	test("declarations die at the closing brace", async () => {
		const input = `
var string outer_alive = "still here"
{
	var string inner = "block-local"
	Console.write(inner)
	Console.write("|")
}
Console.write(outer_alive)
`;
		await build_and_check_output(input, "nested_block_scope", "block-local|still here");
	});

	test("a mv value is released at the block's end (audit-clean)", async () => {
		// The heap string is created and consumed inside the block; its
		// scope-exit free must fire at the closing brace, not the function's.
		const input = `
var string before = "before"
{
	var string temp = "heap value".to_string()
	Console.write(temp)
	Console.write("|")
}
Console.write(before)
`;
		await build_and_check_output(input, "nested_block_destroy", "heap value|before");
	});

	test("a block-local is invisible after the block (checker)", () => {
		const parsed = parse_with_imports(
			`
{
	var int hidden = 5
	Console.write("\\{hidden}")
}
var int z = hidden
`,
		) as any;
		const result = build(parsed.root, { arch: "c" });
		const errors = [...parsed.errors, ...(result.errors ?? [])];
		expect(errors.some((e: any) => e.message.includes("Unknown value: hidden"))).toBe(true);
	});

	test("a block shadows an outer binding", async () => {
		const input = `
var string x = "outer"
{
	var string x = "inner"
	Console.write(x)
	Console.write("|")
}
Console.write(x)
`;
		await build_and_check_output(input, "nested_block_shadow", "inner|outer");
	});

	test("return inside a block returns from the function", async () => {
		const input = `
func pick = (int k, out string) {
	{
		if k == 0 {
			return "seven"
		}
	}
	return "nine"
}
Console.write(pick(0))
Console.write("|")
Console.write(pick(1))
`;
		await build_and_check_output(input, "nested_block_return", "seven|nine");
	});

	test("nested blocks nest", async () => {
		const input = `
{
	var string a = "a"
	{
		var string b = "b"
		Console.write(b)
		Console.write("|")
	}
	Console.write(a)
}
Console.write("done")
`;
		await build_and_check_output(input, "nested_block_deep", "b|adone");
	});
});
