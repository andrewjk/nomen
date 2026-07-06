import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// BUILD
describe("declaration build", () => {
	test("const int declaration", async () => {
		const input = `
const x = 5
Console.write("\\{x}")
`;
		await build_and_check_output(input, "decl_const_int", "5");
	});

	test("const with explicit type", async () => {
		const input = `
const int x = 42
Console.write("\\{x}")
`;
		await build_and_check_output(input, "decl_const_explicit_type", "42");
	});

	test("var with value", async () => {
		const input = `
var x = 10
Console.write("\\{x}")
`;
		await build_and_check_output(input, "decl_var_with_value", "10");
	});

	test("var reassigned", async () => {
		const input = `
var x = 10
x = 20
Console.write("\\{x}")
`;
		await build_and_check_output(input, "decl_var_reassigned", "20");
	});

	test("var with type and assignment", async () => {
		const input = `
var int x
x = 99
Console.write("\\{x}")
`;
		await build_and_check_output(input, "decl_var_type_assign", "99");
	});

	test("const string declaration", async () => {
		const input = `
const name = "world"
Console.write("\\{name}")
`;
		await build_and_check_output(input, "decl_const_string", "world");
	});

	test("const bool declaration", async () => {
		const input = `
const flag = true
Console.write("\\{flag}")
`;
		await build_and_check_output(input, "decl_const_bool", "true");
	});

	test("multiple declarations", async () => {
		const input = `
const a = 10
const b = 20
Console.write("\\{a + b}")
`;
		await build_and_check_output(input, "decl_multiple", "30");
	});

	test("const with expression value", async () => {
		const input = `
const x = 3 + 4
Console.write("\\{x}")
`;
		await build_and_check_output(input, "decl_const_expression", "7");
	});

	test("var updated in if block", async () => {
		const input = `
var x = 5
if true {
  x = 15
}
Console.write("\\{x}")
`;
		await build_and_check_output(input, "decl_var_if_update", "15");
	});

	test("const set in both branches", async () => {
		const input = `
const int x
if true {
  x = 1
} else {
  x = 2
}
Console.write("\\{x}")
`;
		await build_and_check_output(input, "decl_const_branches", "1");
	});

	test("declaration with negative value", async () => {
		const input = `
const x = -5
Console.write("\\{x}")
`;
		await build_and_check_output(input, "decl_negative", "-5");
	});

	test("const with array type and value", async () => {
		const input = `
const x = Array(10, 20, 30)
Console.write("\\{x.at(1)}")
`;
		await build_and_check_output(input, "decl_const_array", "20");
	});
});

// ERRORS
describe("declaration errors", () => {
	test("unknown type", () => {
		const input = `
const what x
`;
		const expected = [test_error(input, "Unknown type: what", 2, 7)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("unknown value", () => {
		const input = `
const x = z0
`;
		const expected = [test_error(input, "Unknown value: z0", 2, 11)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type mismatch", () => {
		const input = `
const int x = "string?!"
`;
		const expected = [
			test_error(input, "Type mismatch in declaration: string (expected int)", 2, 15),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type mismatch -- array", () => {
		const input = `
const int x = Array(1, 2)"
`;
		const expected = [
			test_error(input, "Type mismatch in declaration: Array<int> (expected int)", 2, 15),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type mismatch -- array 2", () => {
		const input = `
const Array<int> x = 3"
`;
		const expected = [
			test_error(input, "Type mismatch in declaration: int (expected Array<int>)", 2, 22),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type mismatch -- unknown value", () => {
		const input = `
const int x = z0
`;
		const expected = [test_error(input, "Unknown value: z0", 2, 15)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("no type or default value", () => {
		const input = `
const x
`;
		const expected = [test_error(input, "Expected type or default value", 2, 7)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("unknown type with value", () => {
		const input = `
const what x = 5
`;
		const expected = [
			test_error(input, "Unknown type: what", 2, 7),
			test_error(input, "Type mismatch in declaration: int (expected what)", 2, 16),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("reassignment to const", () => {
		const input = `
const x = 5
x = 10
`;
		const expected = [test_error(input, "Assignment to const: x", 3, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("incomplete conditional const", () => {
		// Wrap in a function with a parameter so the compiler can't evaluate
		// the condition at compile time.
		const input = `
func f = (int dummy) {
  const int x
  if dummy > 0 {
    x = 5
  }
  const y = x
}
`;
		const expected = [test_error(input, "Const set incompletely: x", 4, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
