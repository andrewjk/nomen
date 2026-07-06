import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// BUILD
describe("operations build", () => {
	test("addition", async () => {
		const input = `
const x = 5 + 3
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_addition", "8");
	});

	test("subtraction", async () => {
		const input = `
const x = 10 - 3
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_subtraction", "7");
	});

	test("multiplication", async () => {
		const input = `
const x = 4 * 3
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_multiplication", "12");
	});

	test("division", async () => {
		const input = `
const x = 10 / 2
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_division", "5");
	});

	test("modulo", async () => {
		const input = `
const x = 10 % 3
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_modulo", "1");
	});

	test("operator precedence", async () => {
		const input = `
const x = 1 + 2 * 3
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_precedence", "7");
	});

	test("grouped precedence", async () => {
		const input = `
const x = (1 + 2) * 3
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_grouped", "9");
	});

	test("negative numbers in operations", async () => {
		const input = `
const x = -5 + 3
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_negative", "-2");
	});

	test("multiple operations in expression", async () => {
		const input = `
const x = 2 + 3 * 4 - 5 / 5
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_multiple", "13");
	});

	test("operations with variables", async () => {
		const input = `
const a = 5
const b = 3
const c = a + b
Console.write("\\{c}")
`;
		await build_and_check_output(input, "operations_variables", "8");
	});

	test("operations in assignment", async () => {
		const input = `
var x = 0
x = x + 1
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_assignment", "1");
	});

	test("compound addition", async () => {
		const input = `
var x = 5
x += 3
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_compound_add", "8");
	});

	test("compound subtraction", async () => {
		const input = `
var x = 10
x -= 3
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_compound_sub", "7");
	});

	test("compound multiplication", async () => {
		const input = `
var x = 4
x *= 3
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_compound_mul", "12");
	});

	test("series of operations", async () => {
		const input = `
const x = 1 + 2 - 3 + 4
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_series", "4");
	});

	test("operations in function call", async () => {
		const input = `
func add = (int a, int b, out int) {
  return a + b
}

const result = add(5, 3)
Console.write("\\{result}")
`;
		await build_and_check_output(input, "operations_function", "8");
	});

	test("operations with zero", async () => {
		const input = `
const x = 5 + 0
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_zero", "5");
	});

	test("large number operations", async () => {
		const input = `
const x = 1000000 + 2000000
Console.write("\\{x}")
`;
		await build_and_check_output(input, "operations_large", "3000000");
	});
});

test("comparison with && (both true)", async () => {
	const input = `
const x = 5
var int result = 0
if x > 3 && x < 7 {
	result = 1
}
Console.write("\\{result}")
`;
	await build_and_check_output(input, "op_and_both_true", "1");
});

test("comparison with && (one false)", async () => {
	const input = `
const x = 10
var int result = 0
if x > 3 && x < 7 {
	result = 1
}
Console.write("\\{result}")
`;
	await build_and_check_output(input, "op_and_one_false", "0");
});

test("comparison with || (both false)", async () => {
	const input = `
const x = 2
var int result = 0
if x > 3 || x < 1 {
	result = 1
}
Console.write("\\{result}")
`;
	await build_and_check_output(input, "op_or_both_false", "0");
});

test("comparison with || (one true)", async () => {
	const input = `
const x = 10
var int result = 0
if x > 3 || x < 7 {
	result = 1
}
Console.write("\\{result}")
`;
	await build_and_check_output(input, "op_or_one_true", "1");
});

test("chained && and ||", async () => {
	const input = `
const x = 5
var int result = 0
if x > 0 && x < 10 || x == 20 {
	result = 1
}
Console.write("\\{result}")
`;
	await build_and_check_output(input, "op_chained_and_or", "1");
});

test("equality with &&", async () => {
	const input = `
const x = 5
var int result = 0
if x == 5 && x != 3 {
	result = 1
}
Console.write("\\{result}")
`;
	await build_and_check_output(input, "op_equality_and", "1");
});

test(">= and <= with &&", async () => {
	const input = `
const x = 5
var int result = 0
if x >= 5 && x <= 5 {
	result = 1
}
Console.write("\\{result}")
`;
	await build_and_check_output(input, "op_gte_lte_and", "1");
});

test("arithmetic with comparison and &&", async () => {
	const input = `
const x = 5
var int result = 0
if x + 1 > 3 && x - 1 < 7 {
	result = 1
}
Console.write("\\{result}")
`;
	await build_and_check_output(input, "op_arith_cmp_and", "1");
});

// ERRORS
describe("operations errors", () => {
	test("type mismatch in operation", () => {
		const input = `
const x = 5 + "hello"
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.some((e) => e.message.includes("Type mismatch"))).toBe(true);
	});

	test("declaration type mismatch", () => {
		const input = `
const int x = "hello" + "world"
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.some((e) => e.message.includes("Type mismatch"))).toBe(true);
	});

	test("assignment type mismatch", () => {
		const input = `
var int x
x = "hello" + "world"
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.some((e) => e.message.includes("Type mismatch"))).toBe(true);
	});

	// TODO: This needs runtime protection
	test.skip("division by zero", () => {
		const input = `
const x = 5 / 0
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	// TODO: This needs runtime protection
	test.skip("modulo by zero", () => {
		const input = `
const x = 5 % 0
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("undefined variable in operation", () => {
		const input = `
const x = undefined_var + 5
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.some((e) => e.message.includes("Unknown value: undefined_var"))).toBe(
			true,
		);
	});

	test("invalid operator", () => {
		const input = `
const x = 5 @ 3
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("missing operand", () => {
		const input = `
const x = 5 +
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("incomplete expression", () => {
		const input = `
const x = + 5
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});
