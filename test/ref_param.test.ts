import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("ref_param_read", result, "42");
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("ref_param_comparison", result, "5");
	});

	test("ref int param used in arithmetic", async () => {
		const input = `
func add_one = (ref int x, out int) {
  return x + 1
}

var int num = 10
Console.write("\\{add_one(ref num)}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("ref_param_arithmetic", result, "11");
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("ref_param_write", result, "99");
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("ref_param_multiple", result, "10");
	});
});
