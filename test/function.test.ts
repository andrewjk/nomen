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

	// A struct-returning call inside another struct-returning function must
	// still receive a valid sret destination in x8 at the call site — x8 is
	// caller-saved, so any intervening call leaves garbage there and the
	// callee's result copy faults (SIGSEGV on aarch64). The func-value call
	// (`blr x8`) first is the deterministic trigger: it leaves x8 holding a
	// read-only code address, so the callee's `str` through it always faults.
	test("struct return forwarded through struct-returning caller", async () => {
		const input = `
struct Point {
  var x = 0
  var y = 0
}

func inner = (int v, out Point) {
  var p = Point()
  p.x = v
  p.y = 10
  return p
}

func inc = (int a, out int) {
  return a + 1
}

func outer = (func (int, out int) cb, int v, out Point) {
  const int ignored = cb(v)
  return inner(v)
}

var Point q = outer(inc, 3)
Console.write_line("\\{q.x} \\{q.y}")
`;
		await build_and_check_output(input, "function_sret_forward", "3 10\n");
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

	test("function with local var copied from param", async () => {
		const input = `
func increment = (int x, out int) {
  var int y = x
  y = y + 1
  return y
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
		await build_and_check_output(input, "function_default_param_set", "Hello Alice!");
	});

	test("multi-line param list with trailing comma", async () => {
		const input = `
func add3 = (
  int a,
  int b,
  int c,
  out int,
) {
  return a + b + c
}
Console.write("\\{add3(1, 2, 3)}")
`;
		await build_and_check_output(input, "function_multiline_trailing_comma", "6");
	});

	test("multi-line ref param with trailing comma", async () => {
		const input = `
func bump = (
  ref int n,
  int by,
  out int,
) {
  return n + by
}
var int x = 10
Console.write("\\{bump(ref x, 5)}")
`;
		await build_and_check_output(input, "function_multiline_ref_trailing_comma", "15");
	});

	test("trailing comma after out return type", async () => {
		const input = `
func two = (int a, int b, out int,) {
  return a + b
}
Console.write("\\{two(3, 4)}")
`;
		await build_and_check_output(input, "function_trailing_comma_after_out", "7");
	});

	test("multi-line param list without trailing comma", async () => {
		const input = `
func sub = (
  int a,
  int b,
  out int,
) {
  return a - b
}
Console.write("\\{sub(9, 4)}")
`;
		await build_and_check_output(input, "function_multiline_no_trailing_comma", "5");
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

	test("nested function cannot capture outer local (read)", () => {
		const input = `
func outer = (int base, out int) {
    func inner = (out int) {
        return base
    }
    return inner()
}
`;
		const parsed = parse(input);
		expect(parsed.errors.some((e) => e.message.includes("cannot capture outer local 'base'"))).toBe(
			true,
		);
	});

	test("nested function cannot capture outer local (write)", () => {
		const input = `
func outer = () {
    var int counter = 0
    func bump = () {
        counter = counter + 1
    }
    bump()
}
`;
		const parsed = parse(input);
		expect(
			parsed.errors.some((e) => e.message.includes("cannot capture outer local 'counter'")),
		).toBe(true);
	});

	test("nested function may use its own params and a module global", () => {
		const input = `
const int SCALE = 10
func outer = (int x, out int) {
    func inner = (int y, out int) {
        return y * SCALE
    }
    return inner(x)
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("trailing comma in single-param list", () => {
		const input = `
func f = (int a, out int,) {
  return a
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("trailing comma after ref self", () => {
		const input = `
struct S {
  var int n
  func bump = (ref self, int by,) {
    self.n = self.n + by
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("trailing comma in func-type param list", () => {
		const input = `
func apply = (func (int, out int,) cb, int x, out int) {
  return cb(x)
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("trailing comma in empty-then-out signature", () => {
		const input = `
func f = (out int,) {
  return 7
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});
});
