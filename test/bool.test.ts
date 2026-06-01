import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("bool build", () => {
	test("const bool true in if", async () => {
		const input = `
const bool flag = true
var int result = 0
if flag {
	result = 1
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("bool_const_true", result, "1");
	});

	test("const bool false in if", async () => {
		const input = `
const bool flag = false
var int result = 0
if flag {
	result = 1
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("bool_const_false", result, "0");
	});

	test("comparison result stored in const bool", async () => {
		const input = `
const int x = 5
const bool flag = x > 3
var int result = 0
if flag {
	result = 1
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("bool_cmp_stored", result, "1");
	});

	test("comparison false stored in const bool", async () => {
		const input = `
const int x = 2
const bool flag = x > 3
var int result = 0
if flag {
	result = 1
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("bool_cmp_false_stored", result, "0");
	});

	test("bool passed to function", async () => {
		const input = `
func check = (bool flag, out int) {
	if flag {
		return 1
	}
	return 0
}

const bool flag = true
const result = check(flag)
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("bool_func_param", result, "1");
	});

	test("bool from comparison in function return", async () => {
		const input = `
func is_positive = (int x, out bool) {
	return x > 0
}

const bool result = is_positive(5)
var int output = 0
if result {
	output = 1
}
Console.write("\\{output}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("bool_func_return", result, "1");
	});

	test("negated bool", async () => {
		const input = `
const bool flag = true
var int result = 0
if !flag {
	result = 1
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("bool_negated", result, "0");
	});

	test("bool equality comparison", async () => {
		const input = `
const bool a = true
const bool b = true
var int result = 0
if a == b {
	result = 1
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("bool_equality", result, "1");
	});
});
