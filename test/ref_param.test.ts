import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// BUILD
describe("ref param dereference", () => {
	test("reading ref int param returns correct value", async () => {
		const input = `
func read_ref = (ref int x, out int) {
  return x
}

var int num = 42
Console.write("\\{read_ref(ref num)}")
`;
		await build_and_check_output(input, "ref_param_read", "42");
	});

	test("ref int param used in comparison", async () => {
		const input = `
func count_up = (ref int limit, out int) {
  var int count = 0
  var int i = 0
  while i < limit {
    count = count + 1
    i = i + 1
  }
  return count
}

var int n = 5
Console.write("\\{count_up(ref n)}")
`;
		await build_and_check_output(input, "ref_param_comparison", "5");
	});

	test("ref int param used in arithmetic", async () => {
		const input = `
func add_one = (ref int x, out int) {
  return x + 1
}

var int num = 10
Console.write("\\{add_one(ref num)}")
`;
		await build_and_check_output(input, "ref_param_arithmetic", "11");
	});

	test("writing to ref int param modifies caller variable", async () => {
		const input = `
func set_val = (ref int x) {
  x = 99
}

var int num = 1
set_val(ref num)
Console.write("\\{num}")
`;
		await build_and_check_output(input, "ref_param_write", "99");
	});

	test("multiple ref params read correctly", async () => {
		const input = `
func swap_check = (ref int a, ref int b, out int) {
  var int tmp = a
  a = b
  return tmp + b
}

var int x = 3
var int y = 7
Console.write("\\{swap_check(ref x, ref y)}")
`;
		await build_and_check_output(input, "ref_param_multiple", "10");
	});
});
