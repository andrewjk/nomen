import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
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
		await build_and_check_output(input, "function_no_params", "hello");
	});

	test("function with return value", async () => {
		const input = `
func get_num = (out int) {
  return 5
}
Console.write("\\{get_num()}")
`;
		await build_and_check_output(input, "function_return_value", "5");
	});

	test("function with params", async () => {
		const input = `
func add = (int a, int b, out int) {
  return a + b
}
Console.write("\\{add(3, 4)}")
`;
		await build_and_check_output(input, "function_with_params", "7");
	});

	test("arrow function", async () => {
		const input = `
func double = (int x, out int) => x * 2
Console.write("\\{double(6)}")
`;
		await build_and_check_output(input, "function_arrow", "12");
	});

	test("arrow function infers return type without out", async () => {
		const input = `
func double = (int x) => x * 2
Console.write("\\{double(6)}")
`;
		await build_and_check_output(input, "function_arrow_inferred", "12");
	});

	test("function called multiple times", async () => {
		const input = `
func square = (int x, out int) => x * x
Console.write("\\{square(3)} \\{square(5)}")
`;
		await build_and_check_output(input, "function_called_multi", "9 25");
	});

	test("function with var param", async () => {
		const input = `
func increment = (var int x, out int) {
  x = x + 1
  return x
}
Console.write("\\{increment(10)}")
`;
		await build_and_check_output(input, "function_var_param", "11");
	});

	test("function with default param", async () => {
		const input = `
func greet = (string name = "world") {
  Console.write("Hello \\{name}!")
}
greet()
`;
		await build_and_check_output(input, "function_default_param", "Hello world!");
	});

	test("function with string return", async () => {
		const input = `
func make_greeting = (string name, out string) {
  return "Hi \\{name}!"
}
Console.write(make_greeting("Alice"))
`;
		await build_and_check_output(input, "function_string_return", "Hi Alice!");
	});

	test("nested function calls", async () => {
		const input = `
func double = (int x, out int) => x * 2
func add = (int a, int b, out int) => a + b
Console.write("\\{add(double(3), 4)}")
`;
		await build_and_check_output(input, "function_nested_calls", "10");
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
		await build_and_check_output(input, "function_local_vars", "15");
	});

	test("function returning boolean", async () => {
		const input = `
func is_positive = (int x, out bool) {
  return x > 0
}
Console.write("\\{is_positive(5)}")
`;
		await build_and_check_output(input, "function_return_bool", "true");
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
		await build_and_check_output(input, "function_multiple_returns", "7 3");
	});

	test("function with three params", async () => {
		const input = `
func sum3 = (int a, int b, int c, out int) => a + b + c
Console.write("\\{sum3(1, 2, 3)}")
`;
		await build_and_check_output(input, "function_three_params", "6");
	});

	test("function with negative return", async () => {
		const input = `
func negate = (int x, out int) => 0 - x
Console.write("\\{negate(7)}")
`;
		await build_and_check_output(input, "function_negate", "-7");
	});

	test("function with expression return", async () => {
		const input = `
func calc = (int a, int b, out int) => (a + b) * 2
Console.write("\\{calc(3, 4)}")
`;
		await build_and_check_output(input, "function_expr_return", "14");
	});

	test("function with arrow return", async () => {
		const input = `
func calc = (int a, int b, out int) {
	=> a + b
}
Console.write("\\{calc(3, 4)}")
`;
		await build_and_check_output(input, "function_expr_return", "7");
	});

	test("function using console write inside", async () => {
		const input = `
func say_hi = () {
  Console.write("hi ")
  Console.write("there")
}
say_hi()
`;
		await build_and_check_output(input, "function_console_write", "hi there");
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
		await build_and_check_output(input, "function_recursive", "120");
	});

	test("function with default param", async () => {
		const input = `
func greet = (string name, string greeting = "Hello") {
  Console.write("\\{greeting} \\{name}!")
}
greet("Alice")
`;
		await build_and_check_output(input, "function_default_param", "Hello Alice!");
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
		const expected = Array(
			test_error(input, "Type mismatch in return: string (expected int)", 3, 10),
		);
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

	test("return value without out return type", () => {
		const input = `
func add = (int a, int b) {
  return a + b
}
`;
		const expected = [
			test_error(input, "Function returns a value but has no 'out' return type", 3, 3),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("one-line return type mismatch", () => {
		const input = `
func add = (out int) => ("string")
`;
		const expected = Array(
			test_error(input, "Type mismatch in return: string (expected int)", 2, 27),
		);
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
