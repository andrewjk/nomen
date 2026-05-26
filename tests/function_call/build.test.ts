import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Function call build");

test("function without params", () => {
	const input = `
func greet() {}
greet()
`;
	const parsed = parse(input);
	const result = build(parsed.root);
	const expected = `
void greet()
{
}
greet();
`;
	expect(parsed.errors).toEqual([]);
	expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("function with params", () => {
	const input = `
func greet(name: string, position: string) {}
greet("Andrew", "Manager")
`;
	const parsed = parse(input);
	const result = build(parsed.root);
	const expected = `
void greet(char* name, char* position)
{
}
greet("Andrew", "Manager");
`;
	expect(parsed.errors).toEqual([]);
	expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
