import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("function call build", () => {
	test("function without params", async () => {
		const input = `
func greet = () {
  Console.write("hello")
}
greet()
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("func_call_no_params", result, "hello");
	});

	test("function with string params", async () => {
		const input = `
func greet = (string name, string title) {
  Console.write("\\{title} \\{name}")
}
greet("Andrew", "Manager")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("func_call_string_params", result, "Manager Andrew");
	});

	test("function call with return value", async () => {
		const input = `
func add = (int a, int b, out int) => a + b
const x = add(1, 2)
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("func_call_return_value", result, "3");
	});

	test("function call with default param", async () => {
		const input = `
func greet = (string name, string greeting = "Hello") {
  Console.write("\\{greeting} \\{name}")
}
greet("Andrew")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("func_call_default_param", result, "Hello Andrew");
	});

	test("function call with all default params provided", async () => {
		const input = `
func greet = (string name, string greeting = "Hello") {
  Console.write("\\{greeting} \\{name}")
}
greet("Andrew", "Hi")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("func_call_override_default", result, "Hi Andrew");
	});

	test("chained function calls", async () => {
		const input = `
func double = (int x, out int) => x * 2
func triple = (int x, out int) => x * 3
Console.write("\\{triple(double(2))}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("func_call_chained", result, "12");
	});

	test("function call in expression", async () => {
		const input = `
func get_val = (out int) => 10
Console.write("\\{get_val() + 5}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("func_call_in_expr", result, "15");
	});

	test("function call with int params", async () => {
		const input = `
func multiply = (int a, int b, out int) => a * b
Console.write("\\{multiply(4, 7)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("func_call_int_params", result, "28");
	});

	test("function call with function params", async () => {
		const input = `
func multiply = (int a, out int) => a * 5
func apply_func_to_num = (int num, func (int, out int) f, out int) => f(num)
Console.write("\\{apply_func_to_num(4, multiply)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("func_call_func_param", result, "20");
	});
});

// ERRORS
describe("function call errors", () => {
	test("function not found", () => {
		const input = `
greet()
`;
		const expected = [test_error(input, "Function not found: greet", 2, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("too many parameters", () => {
		const input = `
func greet = (int first, int second) {}
greet(1, 2, 3)
`;
		const expected = [test_error(input, "Too many parameters for function: greet", 3, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("parameters missing", () => {
		const input = `
func greet = (int first, int second) {}
greet(1)
`;
		const expected = [test_error(input, "Parameters missing for function: greet", 3, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("param type mismatch", () => {
		const input = `
func greet = (int age) {}
greet("andrew")
`;
		const expected = [test_error(input, "Type mismatch in param: string (expected int)", 3, 7)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("param type mismatch -- unknown value", () => {
		const input = `
func greet = (int age) {}
greet(z0)
`;
		const expected = [test_error(input, "Unknown value: z0", 3, 7)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
