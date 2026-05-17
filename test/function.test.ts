import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("function build", () => {
	test("function with no params", async () => {
		const input = `
func greet = () {
  Console.write("hello")
}
greet()
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_no_params", result, "hello");
	});

	test("function with return value", async () => {
		const input = `
func get_num = (out int) {
  return 5
}
Console.write("\\{get_num()}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_return_value", result, "5");
	});

	test("function with params", async () => {
		const input = `
func add = (int a, int b, out int) {
  return a + b
}
Console.write("\\{add(3, 4)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_with_params", result, "7");
	});

	test("arrow function", async () => {
		const input = `
func double = (int x, out int) => x * 2
Console.write("\\{double(6)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_arrow", result, "12");
	});

	test("function called multiple times", async () => {
		const input = `
func square = (int x, out int) => x * x
Console.write("\\{square(3)} \\{square(5)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_called_multi", result, "9 25");
	});

	test("function with var param", async () => {
		const input = `
func increment = (var int x, out int) {
  x = x + 1
  return x
}
Console.write("\\{increment(10)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_var_param", result, "11");
	});

	test("function with default param", async () => {
		const input = `
func greet = (string name = "world") {
  Console.write("Hello \\{name}!")
}
greet()
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_default_param", result, "Hello world!");
	});

	test("function with string return", async () => {
		const input = `
func make_greeting = (string name, out string) {
  return "Hi \\{name}!"
}
Console.write(make_greeting("Alice"))
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_string_return", result, "Hi Alice!");
	});

	test("nested function calls", async () => {
		const input = `
func double = (int x, out int) => x * 2
func add = (int a, int b, out int) => a + b
Console.write("\\{add(double(3), 4)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_nested_calls", result, "10");
	});

	test("function with local variables", async () => {
		const input = `
func sum_to = (int n, out int) {
  var total = 0
  var i = 1
  while i <= n {
    total = total + i
    i = i + 1
  }
  return total
}
Console.write("\\{sum_to(5)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_local_vars", result, "15");
	});

	test("function returning boolean", async () => {
		const input = `
func is_positive = (int x, out bool) {
  return x > 0
}
Console.write("\\{is_positive(5)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_return_bool", result, "true");
	});

	test("multiple returns with if else", async () => {
		const input = `
func abs = (int x, out int) {
  if x < 0 {
    return 0 - x
  } else {
    return x
  }
}
Console.write("\\{abs(-7)} \\{abs(3)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_multiple_returns", result, "7 3");
	});

	test("function with three params", async () => {
		const input = `
func sum3 = (int a, int b, int c, out int) => a + b + c
Console.write("\\{sum3(1, 2, 3)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_three_params", result, "6");
	});

	test("function with negative return", async () => {
		const input = `
func negate = (int x, out int) => 0 - x
Console.write("\\{negate(7)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_negate", result, "-7");
	});

	test("function with expression return", async () => {
		const input = `
func calc = (int a, int b, out int) => (a + b) * 2
Console.write("\\{calc(3, 4)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_expr_return", result, "14");
	});

	test("function with arrow return", async () => {
		const input = `
func calc = (int a, int b, out int) {
	=> a + b
}
Console.write("\\{calc(3, 4)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_expr_return", result, "7");
	});

	test("function using console write inside", async () => {
		const input = `
func say_hi = () {
  Console.write("hi ")
  Console.write("there")
}
say_hi()
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_console_write", result, "hi there");
	});

	test("recursive function", async () => {
		const input = `
func factorial = (int n, out int) {
  if n <= 1 {
    return 1
  }
  return n * factorial(n - 1)
}
Console.write("\\{factorial(5)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_recursive", result, "120");
	});

	test("function with default param", async () => {
		const input = `
func greet = (string name, string greeting = "Hello") {
  Console.write("\\{greeting} \\{name}!")
}
greet("Alice")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("function_default_param", result, "Hello Alice!");
	});
});

// ERRORS
describe("function errors", () => {
	test("unknown param type", () => {
		const input = `
func add = (what a) {}
`;
		const expected = [test_error(input, "Unknown type: what", 2, 13)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("unknown param value type", () => {
		const input = `
func add = (a = z0) {}
`;
		const expected = [test_error(input, "Unknown value: z0", 2, 17)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("param type mismatch", () => {
		const input = `
func add = (int a = "string?!") {}
`;
		const expected = [
			test_error(input, "Type mismatch in param default: string (expected int)", 2, 21),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("param type mismatch - unknown value", () => {
		const input = `
func add = (int a = z0) {}
`;
		const expected = [test_error(input, "Unknown value: z0", 2, 21)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("no param type or default value", () => {
		const input = `
func add = (a) {}
`;
		const expected = [test_error(input, "Expected type or default value", 2, 13)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("unknown return value type", () => {
		const input = `
func add = (out what) {
  return 5
}
`;
		const expected = [test_error(input, "Unknown type: what", 2, 17)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("return type mismatch", () => {
		const input = `
func add = (out int) {
  return "string?!"
}
`;
		const expected = [test_error(input, "Type mismatch in return: string (expected int)", 3, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("return type mismatch - unknown value", () => {
		const input = `
func add = (out int) {
  return z0
}
`;
		const expected = [test_error(input, "Unknown value: z0", 3, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing return", () => {
		const input = `
func add = (out int) {}
`;
		const expected = [test_error(input, "Missing return", 2, 22)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("one-line return type mismatch", () => {
		const input = `
func add = (out int) => ("string")
`;
		const expected = [test_error(input, "Type mismatch in return: string (expected int)", 2, 27)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("one-line return unknown value", () => {
		const input = `
func add = (out int) => (z0)
`;
		const expected = [test_error(input, "Unknown value: z0", 2, 26)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
