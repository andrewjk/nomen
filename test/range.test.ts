import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("range build", () => {
	test("exclusive range in for loop", async () => {
		const input = `
for i of 1..4 {
  Console.write("\\{i}")
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("range_exclusive_for", result, "123");
	});

	test("inclusive range with expression", async () => {
		const input = `
for i of 1..(4 + 1) {
  Console.write("\\{i}")
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("range_inclusive_expr", result, "1234");
	});

	test("range with negative start", async () => {
		const input = `
for i of -2..2 {
  Console.write("\\{i} ")
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("range_negative_start", result, "-2 -1 0 1 ");
	});

	test("range starting from zero", async () => {
		const input = `
for i of 0..3 {
  Console.write("\\{i}")
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("range_from_zero", result, "012");
	});

	test("range with sum in for loop", async () => {
		const input = `
var total = 0
for i of 1..5 {
  total = total + i
}
Console.write("\\{total}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("range_sum", result, "10");
	});

	test("nested range loops", async () => {
		const input = `
var total = 0
for i of 0..3 {
  for j of 0..2 {
    total = total + 1
  }
}
Console.write("\\{total}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("range_nested", result, "6");
	});

	test("range with single element", async () => {
		const input = `
for i of 0..1 {
  Console.write("\\{i}")
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("range_single_element", result, "0");
	});

	test("range with large bounds", async () => {
		const input = `
var total = 0
for i of 0..5 {
  total = total + i
}
Console.write("\\{total}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("range_large_bounds", result, "10");
	});

	test("range as array literal", async () => {
		const input = `
const x = 1..4
Console.write("\\{x[0]}\\{x[1]}\\{x[2]}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("range_as_array", result, "123");
	});

	test("range used for index-based array access", async () => {
		const input = `
const nums = [10, 20, 30]
var total = 0
for i of 0..3 {
  total = total + nums[i]
}
Console.write("\\{total}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("range_index_access", result, "60");
	});
});

// ERRORS
describe("range errors", () => {
	test("type mismatch", () => {
		const input = `
var x = 1.."b"
`;
		const expected = [test_error(input, "Type mismatch in range: string (expected int)", 2, 12)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("string start of range", () => {
		const input = `
var x = "a".."b"
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("Type mismatch in range");
	});
});
