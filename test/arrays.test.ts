import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("array build", () => {
	test("array with values in for loop", async () => {
		const input = `
const nums = Array(10, 20, 30)
for n of nums {
  Console.write("\\{n} ")
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_for_loop", result, "10 20 30 ");
	});

	test("array access by index", async () => {
		const input = `
const nums = Array(10, 20, 30)
Console.write("\\{nums.at(0)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_access_index_0", result, "10");
	});

	test("var string array with literals in function", async () => {
		const input = `
var words = Array("hello", "world")
Console.write("\\{words.at(0)}\\{words.at(1)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("var_string_array_literals", result, "helloworld");
	});

	test("array access middle element", async () => {
		const input = `
const nums = Array(10, 20, 30)
Console.write("\\{nums.at(1)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_access_middle", result, "20");
	});

	test("array access last element", async () => {
		const input = `
const nums = Array(10, 20, 30)
Console.write("\\{nums.at(2)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_access_last", result, "30");
	});

	test("array with explicit type", async () => {
		const input = `
const nums = Array(5, 10, 15)
Console.write("\\{nums.at(0)} \\{nums.at(1)} \\{nums.at(2)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_explicit_type", result, "5 10 15");
	});

	test("array sum with for loop", async () => {
		const input = `
const nums = Array(1, 2, 3, 4, 5)
var total = 0
for n of nums {
  total = total + n
}
Console.write("\\{total}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_sum_loop", result, "15");
	});

	test("array with index-based access in loop", async () => {
		const input = `
const nums = Array(100, 200, 300)
var total = 0
for i of 0..3 {
  total = total + nums.at(i)
}
Console.write("\\{total}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_index_loop", result, "600");
	});

	test("array with single element", async () => {
		const input = `
const nums = Array(42)
Console.write("\\{nums.at(0)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_single_element", result, "42");
	});

	test("array with negative values", async () => {
		const input = `
const nums = Array(-1, -5, -10)
Console.write("\\{nums.at(0)} \\{nums.at(1)} \\{nums.at(2)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_negative_values", result, "-1 -5 -10");
	});

	test("multiple arrays", async () => {
		const input = `
const a = Array(1, 2, 3)
const b = Array(4, 5, 6)
Console.write("\\{a.at(1)} \\{b.at(1)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_multiple", result, "2 5");
	});

	test("array access with expression index", async () => {
		const input = `
const nums = Array(10, 20, 30)
const i = 2
Console.write("\\{nums.at(i)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_expr_index", result, "30");
	});

	test("empty array with type", async () => {
		const input = `
const Array<int> x
Console.write("ok")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_empty_typed", result, "ok");
	});

	test("nested array access in expression", async () => {
		const input = `
const nums = Array(10, 20, 30)
Console.write("\\{nums.at(0) + nums.at(2)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_access_in_expr", result, "40");
	});

	test("array in function param", async () => {
		const input = `
func sum = (Array<int> nums, out int) {
  var total = 0
  for n of nums {
    total = total + n
  }
  return total
}
const n = sum(Array(2, 4, 6))
Console.write("\\{n}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("array_func_param", result, "12");
	});
});

// ERRORS
describe("array errors", () => {
	test("declaration type mismatch", () => {
		const input = `
const Array<int> x = Array("a", "b", "c")
`;
		const expected = [
			test_error(input, "Type mismatch in array: string (expected int)", 2, 28),
			test_error(input, "Type mismatch in array: string (expected int)", 2, 33),
			test_error(input, "Type mismatch in array: string (expected int)", 2, 38),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("declaration type mixed", () => {
		const input = `
const x = Array(1, "b", 2)
`;
		const expected = Array(
			test_error(input, "Type mismatch in array: string (expected int)", 2, 20),
		);
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("declaration type not an array", () => {
		const input = `
const Array<int> x = 5
`;
		const expected = [
			test_error(input, "Type mismatch in declaration: int (expected Array<int>)", 2, 22),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("assignment type mismatch", () => {
		const input = `
var Array<int> x
x = Array("a", "b", "c")
`;
		const expected = [
			test_error(input, "Type mismatch in array: string (expected int)", 3, 11),
			test_error(input, "Type mismatch in array: string (expected int)", 3, 16),
			test_error(input, "Type mismatch in array: string (expected int)", 3, 21),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("assignment type mixed", () => {
		const input = `
var Array<int> x
x = Array(1, "b", 2)
`;
		const expected = Array(
			test_error(input, "Type mismatch in array: string (expected int)", 3, 14),
		);
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("assignment type not an array", () => {
		const input = `
var Array<int> x
x = 5
`;
		const expected = Array(
			test_error(input, "Type mismatch in assignment: int (expected Array<int>)", 3, 5),
		);
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
