import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A fixed-array (`string[]`) parameter decays to a pointer in the C
// signature, so `items.length` compiled to
// `sizeof(items) / sizeof(nomen_string)` — pointer-size / elem-size, i.e. 0
// for fat strings — and the callee saw an empty array (aarch64 was correct;
// it uses the checker-stamped compile-time length). `.length` on a
// length-bearing array param now emits that stamped length directly.

describe("string[] parameter .length", () => {
	test("items.length on a string[] parameter", async () => {
		const input = `
import System

func sum_lengths = (string[] items, out int) {
	var total = 0
	var i = 0
	while i < items.length; i += 1 {
		total += items.at_or_panic(i).length
	}
	return total
}

pub func main = (Init init) {
	var total = sum_lengths(["abc", "de"])
	Console.write("total=\\{total}\\n")
}
`;
		await build_and_check_output(
			input,
			"string_array_param_length",
			"total=5\n",
			true,
		);
	});

	test("int[] parameter length drives a for loop", async () => {
		const input = `
import System

func sum = (int[] values, out int) {
	var total = 0
	for v of values {
		total += v
	}
	return total
}

pub func main = (Init init) {
	Console.write("sum=\\{sum([10, 20, 30])}\\n")
}
`;
		await build_and_check_output(input, "int_array_param_length", "sum=60\n", true);
	});
});
