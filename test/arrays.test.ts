import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
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
		await build_and_check_output(input, "array_for_loop", "10 20 30 ");
	});

	test("array access by index", async () => {
		const input = `
const nums = Array(10, 20, 30)
Console.write("\\{nums.at(0)}")
`;
		await build_and_check_output(input, "array_access_index_0", "10");
	});

	test("var string array with literals in function", async () => {
		const input = `
var words = Array("hello", "world")
Console.write("\\{words.at(0)}\\{words.at(1)}")
`;
		await build_and_check_output(input, "var_string_array_literals", "helloworld");
	});

	test("array access middle element", async () => {
		const input = `
const nums = Array(10, 20, 30)
Console.write("\\{nums.at(1)}")
`;
		await build_and_check_output(input, "array_access_middle", "20");
	});

	test("array access last element", async () => {
		const input = `
const nums = Array(10, 20, 30)
Console.write("\\{nums.at(2)}")
`;
		await build_and_check_output(input, "array_access_last", "30");
	});

	test("array with explicit type", async () => {
		const input = `
const nums = Array(5, 10, 15)
Console.write("\\{nums.at(0)} \\{nums.at(1)} \\{nums.at(2)}")
`;
		await build_and_check_output(input, "array_explicit_type", "5 10 15");
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
		await build_and_check_output(input, "array_sum_loop", "15");
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
		await build_and_check_output(input, "array_index_loop", "600");
	});

	test("array with single element", async () => {
		const input = `
const nums = Array(42)
Console.write("\\{nums.at(0)}")
`;
		await build_and_check_output(input, "array_single_element", "42");
	});

	test("array with negative values", async () => {
		const input = `
const nums = Array(-1, -5, -10)
Console.write("\\{nums.at(0)} \\{nums.at(1)} \\{nums.at(2)}")
`;
		await build_and_check_output(input, "array_negative_values", "-1 -5 -10");
	});

	test("multiple arrays", async () => {
		const input = `
const a = Array(1, 2, 3)
const b = Array(4, 5, 6)
Console.write("\\{a.at(1)} \\{b.at(1)}")
`;
		await build_and_check_output(input, "array_multiple", "2 5");
	});

	test("array access with expression index", async () => {
		const input = `
const nums = Array(10, 20, 30)
const i = 2
Console.write("\\{nums.at(i)}")
`;
		await build_and_check_output(input, "array_expr_index", "30");
	});

	test("empty array with type", async () => {
		const input = `
const Array<int> x
Console.write("ok")
`;
		await build_and_check_output(input, "array_empty_typed", "ok");
	});

	test("nested array access in expression", async () => {
		const input = `
const nums = Array(10, 20, 30)
Console.write("\\{nums.at(0) + nums.at(2)}")
`;
		await build_and_check_output(input, "array_access_in_expr", "40");
	});

	test("array from Array.with() with dynamic length filled with set() and read with at()", async () => {
		const input = `
var length = 3
var result = Array.with(0, length)
if result.length == 3 {
	result.set(0, 10)
	result.set(1, 20)
	result.set(2, 30)
	Console.write("\\{result.at(0)} \\{result.at(1)} \\{result.at(2)}")
}
`;
		await build_and_check_output(input, "array_with_set_at", "10 20 30");
	});

	test("array from Array.with() reports its dynamic length", async () => {
		const input = `
var length = 7
var result = Array.with(0, length)
Console.write("\\{result.length}")
`;
		await build_and_check_output(input, "array_with_length", "7");
	});

	test("array from Array.with() filled in a loop and iterated", async () => {
		const input = `
var length = 5
var result = Array.with(0, length)
for i of 0 .. result.length {
  result.set(i, i * i)
}
for n of result {
  Console.write("\\{n} ")
}
`;
		await build_and_check_output(input, "array_with_for_loop", "0 1 4 9 16 ");
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
		await build_and_check_output(input, "array_func_param", "12");
	});

	test("function returning out int[] with array literal, consumed via .at()", async () => {
		const input = `
func make_nums = (out int[]) {
  return [1, 2, 3]
}
var nums = make_nums()
if nums.length == 3 {
  Console.write("\\{nums.at(0)}\\{nums.at(1)}\\{nums.at(2)}")
}
`;
		await build_and_check_output(input, "array_func_return_literal_at", "123");
	});

	test("global (root-scope) array .at() inside main", async () => {
		const input = `
import System
const nums = Array(10, 20, 30)
pub func main = () {
  Console.write("\\{nums.at(0)} \\{nums.at(1)} \\{nums.at(2)}")
}
`;
		await build_and_check_output(input, "array_global_at_in_func", "10 20 30", true);
	});

	// TODO(aarch64): returning a string[] literal works end-to-end on the C
	// backend (heap array, strdup'd elements freed at scope exit). On aarch64,
	// `.at()` on a heap string array mis-compiles inside multi-arg string
	// interpolation — a pre-existing gap that also affects Array.with (not
	// specific to returns). To enable: fix the aarch64 access/interpolation
	// path so a string returned from `.at()` on a heap (function-returned /
	// Array.with) array is hoisted as a value, not treated as a static label
	// (the bug surfaces as `adr x0, _param_N` against an undefined label in
	// `_main`). The C-backend auto_free already frees heap-string-array
	// elements (build_auto_free.ts); aarch64 uses rodata labels so it needs no
	// per-element free once codegen is corrected.
	test.skip("function returning out string[] with array literal", async () => {
		const input = `
func make_words = (out string[]) {
  return ["a", "b", "c"]
}
var words = make_words()
if words.length == 3 {
  Console.write("\\{words.at(0)}\\{words.at(1)}\\{words.at(2)}")
}
`;
		await build_and_check_output(input, "array_func_return_string_literal", "abc");
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
		// Heterogeneous arrays are now treated as tuples (see tuples.test.ts)
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
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
		// Heterogeneous arrays are now treated as tuples (see tuples.test.ts),
		// but the explicit Array<int> target still mismatches the tuple value.
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
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
