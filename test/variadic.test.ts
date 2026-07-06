import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// BUILD
describe("variadic build", () => {
	test("variadic int params - sum", async () => {
		const input = `
func sum = (...int nums, out int) {
  var total = 0
  var i = 0
  while i < nums.length {
    total = total + nums.at(i)
    i = i + 1
  }
  return total
}
Console.write("\\{sum(1, 2, 3)}")
`;
		await build_and_check_output(input, "variadic_sum", "6");
	});

	test("variadic with zero args", async () => {
		const input = `
func count = (...int nums, out int) => nums.length
Console.write("\\{count()}")
`;
		await build_and_check_output(input, "variadic_zero_args", "0");
	});

	test("variadic with single arg", async () => {
		const input = `
func first = (...int nums, out int) {
  if nums.length > 0 {
    return nums.first()
  }
  return 0
}
Console.write("\\{first(42)}")
`;
		await build_and_check_output(input, "variadic_single_arg", "42");
	});

	test("variadic mixed with fixed params", async () => {
		const input = `
func add_to = (int base, ...int nums, out int) {
  var total = base
  var i = 0
  while i < nums.length {
    total = total + nums.at(i)
    i = i + 1
  }
  return total
}
Console.write("\\{add_to(10, 1, 2, 3)}")
`;
		await build_and_check_output(input, "variadic_mixed", "16");
	});

	test("variadic string params", async () => {
		const input = `
func count_strings = (...string items, out int) => items.length
var n = count_strings("a", "b", "c")
Console.write("\\{n}")
`;
		await build_and_check_output(input, "variadic_strings", "3");
	});
});

// ERRORS
describe("variadic errors", () => {
	test("variadic not last param", () => {
		const input = `
func bad = (...int nums, int x) {}
`;
		const expected = Array(
			test_error(input, "Variadic parameter must be the last parameter", 2, 13),
		);
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("variadic with default value", () => {
		const input = `
func bad = (...int nums = Array(1)) {}
`;
		const expected = Array(
			test_error(input, "Variadic parameter cannot have a default value", 2, 13),
		);
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
