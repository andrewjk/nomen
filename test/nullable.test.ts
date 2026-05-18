import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("nullable parse errors", () => {
	test("null assigned to non-nullable type", () => {
		const input = `
struct Foo {
    var int x
}

const f = Foo(null)
Console.write("ok")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("null"))).toBe(true);
	});

	test("null assigned to non-nullable int", () => {
		const input = `
const int x = null
Console.write("ok")
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors[0].message).toContain("null");
	});
});

describe("nullable usage errors", () => {
	test("using null variable errors", () => {
		const input = `
struct Foo {
    var int x
}

var int? a = null
const b = a + 1
Console.write("\\{b}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("is null"))).toBe(true);
	});

	test("using null variable in function call errors", () => {
		const input = `
var int? x = null
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("is null"))).toBe(true);
	});
});

describe("nullable valid usage", () => {
	test("nullable variable with non-null value works", async () => {
		const input = `
var int? x = 5
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("nullable_non_null", result, "5");
	});

	test("nullable variable declared without value", () => {
		const input = `
var int? x = null
Console.write("ok")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});
