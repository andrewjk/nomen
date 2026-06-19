import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("assignment build", () => {
	test("assignment to var", async () => {
		const input = `
var int x
x = 5
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_to_var", result, "5");
	});

	test("single assignment to const", async () => {
		const input = `
const int x
x = 5
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_to_const", result, "5");
	});

	test("conditional assignment to const", async () => {
		const input = `
const int x
if true {
  x = 5
} else {
  x = 10
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_conditional_const", result, "5");
	});

	test("conditional assignment to const false branch", async () => {
		const input = `
const int x
if false {
  x = 5
} else {
  x = 10
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_conditional_const_false", result, "10");
	});

	test("assignment to var param", async () => {
		const input = `
func add_five = (var int x, out int) {
  x = x + 5
  return x
}
const result = add_five(10)
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_var_param", result, "15");
	});

	test("assignment with addition", async () => {
		const input = `
var x = 10
x = x + 5
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_addition", result, "15");
	});

	test("assignment with subtraction", async () => {
		const input = `
var x = 20
x = x - 8
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_subtraction", result, "12");
	});

	test("assignment with multiplication", async () => {
		const input = `
var x = 6
x = x * 7
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_multiplication", result, "42");
	});

	test("reassign var multiple times", async () => {
		const input = `
var x = 1
x = 2
x = 3
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_multiple", result, "3");
	});

	test("reassign var with expression from other var", async () => {
		const input = `
var a = 10
var b = 20
a = b + a
Console.write("\\{a}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_expr_other_var", result, "30");
	});

	test("assignment in if block", async () => {
		const input = `
var x = 5
if true {
  x = 15
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_in_if", result, "15");
	});

	test("assignment in else block", async () => {
		const input = `
var x = 5
if false {
  x = 15
} else {
  x = 25
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_in_else", result, "25");
	});

	test("var string assignment", async () => {
		const input = `
var name = "hello"
name = "world"
Console.write("\\{name}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_string", result, "world");
	});

	test("assignment with negative value", async () => {
		const input = `
var x = 10
x = -3
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_negative", result, "-3");
	});

	test("assignment in loop", async () => {
		const input = `
var total = 0
for i of 0..5 {
  total = total + i
}
Console.write("\\{total}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_in_loop", result, "10");
	});

	test("const set in both branches then used", async () => {
		const input = `
const int x
if false {
  x = 100
} else {
  x = 200
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("assign_const_both_branches", result, "200");
	});
});

// ERRORS
describe("assignment errors", () => {
	test("type mismatch", () => {
		const input = `
var int x
x = "string?!"
`;
		const expected = [
			test_error(input, "Type mismatch in assignment: string (expected int)", 3, 5),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type mismatch -- array", () => {
		const input = `
var int x
x = [1, 2]
`;
		const expected = [test_error(input, "Type mismatch in assignment: int[] (expected int)", 3, 5)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type mismatch -- array 2", () => {
		const input = `
var int[] x
x = 3
`;
		const expected = [test_error(input, "Type mismatch in assignment: int (expected int[])", 3, 5)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type mismatch -- unknown value", () => {
		const input = `
var int x
x = z0
`;
		const expected = [test_error(input, "Unknown value: z0", 3, 5)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("unknown variable", () => {
		const input = `
var int x
y = "string?!"
`;
		const expected = [test_error(input, "Unknown value: y", 3, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("assignment to const", () => {
		const input = `
const x = 5
x = 10
`;
		const expected = [test_error(input, "Assignment to const: x", 3, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("double assignment to const", () => {
		const input = `
const int x
x = 5
x = 10
`;
		const expected = [test_error(input, "Assignment to const: x", 4, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("incomplete conditional assignment to const", () => {
		const input = `
const int x
var int dummy = 1
if dummy > 0 {
  x = 5
}
const y = x
`;
		const expected = [test_error(input, "Const set incompletely: x", 4, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("assignment to const param", () => {
		const input = `
func set = (int x) {
  x = 5
}
`;
		const expected = [test_error(input, "Assignment to const: x", 3, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type mismatch -- bool to int", () => {
		const input = `
var int x
x = true
`;
		const expected = [test_error(input, "Type mismatch in assignment: bool (expected int)", 3, 5)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
