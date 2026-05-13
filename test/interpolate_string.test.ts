import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("interpolate string build", () => {
	test("basic interpolation", async () => {
		const input = `
const x = 5
Console.write("\\{x} is the value")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("interpolate_basic", result, "5 is the value");
	});

	test("multiple interpolations", async () => {
		const input = `
const x = 5
const y = 10
Console.write("\\{x} + \\{y} = \\{x + y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("interpolate_multiple", result, "5 + 10 = 15");
	});

	test("interpolation with expression", async () => {
		const input = `
const x = 5
Console.write("\\{x * 2} is double")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("interpolate_expression", result, "10 is double");
	});

	test("interpolation with string variable", async () => {
		const input = `
const name = "world"
Console.write("Hello \\{name}!")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("interpolate_string", result, "Hello world!");
	});

	test("interpolation with negative number", async () => {
		const input = `
const x = -5
Console.write("Value: \\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("interpolate_negative", result, "Value: -5");
	});

	test("interpolation with zero", async () => {
		const input = `
const x = 0
Console.write("Zero: \\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("interpolate_zero", result, "Zero: 0");
	});

	test("interpolation in loop", async () => {
		const input = `
var i = 0
while i < 3 {
  Console.write("\\{i} ")
  i = i + 1
}
Console.write("\\n")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("interpolate_loop", result, "0 1 2 \n");
	});

	test("interpolation with function call", async () => {
		const input = `
func get_value = (out int) {
  return 42
}

Console.write("Value: \\{get_value()}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("interpolate_function", result, "Value: 42");
	});

	test("interpolation with boolean", async () => {
		const input = `
const flag = true
Console.write("Flag: \\{flag}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("interpolate_bool", result, "Flag: true");
	});

	test("interpolation with large number", async () => {
		const input = `
const big = 123456789
Console.write("Big: \\{big}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("interpolate_large", result, "Big: 123456789");
	});
});

// ERRORS
describe("interpolate string errors", () => {
	test.skip("undefined variable in interpolation", () => {
		const input = `
const str = "\\{undefined_var}"
`;
		const expected = [test_error(input, "Unknown value: undefined_var", 2 + 2, 16)];
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual(expected);
	});

	test.skip("invalid expression in interpolation", () => {
		const input = `
const str = "\\{x +}"
`;
		const expected = [test_error(input, "Unknown value: }", 2 + 2, 16)];
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual(expected);
	});

	test.skip("nested interpolation", () => {
		const input = `
const x = 5
const str = "\\{\\{x}}"
`;
		const expected = [test_error(input, "Unknown value: }", 2 + 2, 16)];
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual(expected);
	});

	// TODO:
	test.skip("unclosed interpolation brace", () => {
		const input = `
const x = 5
const str = "\\{x"
`;
		const expected = [test_error(input, "Unknown value: }", 2 + 2, 16)];
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual(expected);
	});

	// TODO:
	test.skip("interpolation with type mismatch", () => {
		const input = `
struct Point {
  pub var int x
  pub var int y
}

const p = Point { x = 1, y = 2 }
const str = "\\{p}"
`;
		const expected = [test_error(input, "Unknown value: }", 2 + 2, 16)];
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual(expected);
	});

	test.skip("interpolation with array", () => {
		const input = `
const arr = [1, 2, 3]
const str = "\\{arr}"
`;
		const expected = [test_error(input, "Unknown value: }", 2 + 2, 16)];
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual(expected);
	});

	test.skip("empty interpolation", () => {
		const input = `
const str = "\\{}"
`;
		const expected = [test_error(input, "Unknown value: }", 2 + 2, 16)];
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual(expected);
	});

	// TODO: Should fail at runtime
	test.skip("interpolation with division by zero", () => {
		const input = `
const x = 1
const str = "\\{x / 0}"
`;
		const expected = [test_error(input, "Unknown value: }", 2 + 2, 16)];
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual(expected);
	});
});
