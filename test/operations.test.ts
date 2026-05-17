import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// BUILD
describe("operations build", () => {
	test("addition", async () => {
		const input = `
const x = 5 + 3
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_addition", result, "8");
	});

	test("subtraction", async () => {
		const input = `
const x = 10 - 3
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_subtraction", result, "7");
	});

	test("multiplication", async () => {
		const input = `
const x = 4 * 3
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_multiplication", result, "12");
	});

	test("division", async () => {
		const input = `
const x = 10 / 2
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_division", result, "5");
	});

	test("modulo", async () => {
		const input = `
const x = 10 % 3
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_modulo", result, "1");
	});

	test("operator precedence", async () => {
		const input = `
const x = 1 + 2 * 3
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_precedence", result, "7");
	});

	test("grouped precedence", async () => {
		const input = `
const x = (1 + 2) * 3
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_grouped", result, "9");
	});

	test("negative numbers in operations", async () => {
		const input = `
const x = -5 + 3
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_negative", result, "-2");
	});

	test("multiple operations in expression", async () => {
		const input = `
const x = 2 + 3 * 4 - 5 / 5
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_multiple", result, "13");
	});

	test("operations with variables", async () => {
		const input = `
const a = 5
const b = 3
const c = a + b
Console.write("\\{c}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_variables", result, "8");
	});

	test("operations in assignment", async () => {
		const input = `
var x = 0
x = x + 1
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_assignment", result, "1");
	});

	test("compound addition", async () => {
		const input = `
var x = 5
x += 3
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_compound_add", result, "8");
	});

	test("compound subtraction", async () => {
		const input = `
var x = 10
x -= 3
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_compound_sub", result, "7");
	});

	test("compound multiplication", async () => {
		const input = `
var x = 4
x *= 3
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_compound_mul", result, "12");
	});

	test("series of operations", async () => {
		const input = `
const x = 1 + 2 - 3 + 4
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_series", result, "4");
	});

	test("operations in function call", async () => {
		const input = `
func add = (int a, int b, out int) {
  return a + b
}

const result = add(5, 3)
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_function", result, "8");
	});

	test("operations with zero", async () => {
		const input = `
const x = 5 + 0
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_zero", result, "5");
	});

	test("large number operations", async () => {
		const input = `
const x = 1000000 + 2000000
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("operations_large", result, "3000000");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("op_and_both_true", result, "1");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("op_and_one_false", result, "0");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("op_or_both_false", result, "0");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("op_or_one_true", result, "1");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("op_chained_and_or", result, "1");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("op_equality_and", result, "1");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("op_gte_lte_and", result, "1");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("op_arith_cmp_and", result, "1");
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
