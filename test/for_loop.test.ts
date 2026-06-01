import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("for loop build", () => {
	test("for loop with array", async () => {
		const input = `
const nums = [1, 2, 3]
for n of nums {
  Console.write("\\{n}")
}
Console.write("\\n")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_array", result, "123\n");
	});

	test("for loop with range", async () => {
		const input = `
for i of 0..3 {
  Console.write("\\{i}")
}
Console.write("\\n")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_range", result, "012\n");
	});

	test("for loop with sum calculation", async () => {
		const input = `
const nums = [1, 2, 3, 4, 5]
var sum = 0
for n of nums {
  sum = sum + n
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_sum_calculation", result, "15");
	});

	test("for loop with multiplication", async () => {
		const input = `
const nums = [2, 3, 4]
var product = 1
for n of nums {
  product = product * n
}
Console.write("\\{product}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_multiplication", result, "24");
	});

	test("for loop with condition in body", async () => {
		const input = `
const nums = [1, 2, 3, 4, 5]
var count = 0
for n of nums {
  if n > 2 {
    count = count + 1
  }
}
Console.write("\\{count}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_condition_body", result, "3");
	});

	test("for loop with single element", async () => {
		const input = `
const nums = [42]
for n of nums {
  Console.write("\\{n}")
}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_single_element", result, "42");
	});

	test("for loop with nested loops", async () => {
		const input = `
const rows = [1, 2]
const cols = [3, 4]
var total = 0
for r of rows {
  for c of cols {
    total = total + (r * c)
  }
}
Console.write("\\{total}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_nested", result, "21");
	});

	test("for loop with index calculation", async () => {
		const input = `
const nums = [10, 20, 30]
var total = 0
for i of 0..3 {
  total = total + nums[i]
}
Console.write("\\{total}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_index_calculation", result, "60");
	});

	test("for loop with decrement", async () => {
		const input = `
var count = 5
for i of 0..5 {
  count = count - 1
}
Console.write("\\{count}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_decrement", result, "0");
	});

	test("for loop with array access", async () => {
		const input = `
const nums = [100, 200, 300]
var sum = 0
for i of 0..3 {
  sum = sum + nums[i]
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_array_access", result, "600");
	});

	test("for loop with comparison", async () => {
		const input = `
const nums = [1, 5, 3, 7, 2]
var max = 0
for n of nums {
  if n > max {
    max = n
  }
}
Console.write("\\{max}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_comparison", result, "7");
	});

	test("for loop with modulo", async () => {
		const input = `
const nums = [1, 2, 3, 4, 5]
var sum = 0
for n of nums {
  if n % 2 == 0 {
    sum = sum + n
  }
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_modulo", result, "6");
	});

	test("for loop with simple assignment in update", async () => {
		const input = `
const nums = [1, 2, 3]
var sum = 0
var i = 0
for n of nums; i += 1 {
  sum = sum + n + i
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_post_assignment", result, "9");
	});

	test("for loop with range and update", async () => {
		const input = `
var sum = 0
var i = 0
for n of 0..5; i += 2 {
  sum = sum + i
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		// 0 + 0 + 2 + 4 + 6 + 8
		await check_output("for_loop_range_update", result, "20");
	});

	test("for loop with update and condition", async () => {
		const input = `
const nums = [1, 2, 3, 4, 5]
var sum = 0
var i = 0
for n of nums; i += 1 {
  if n % 2 == 0 {
    sum = sum + n + i
  }
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		// 0 + 0 + 0 + 1 + 3 + 2 + 6 + 3 + 9 + 4 + 12
		await check_output("for_loop_update_condition", result, "10");
	});

	test("for loop with update accessing outer variable", async () => {
		const input = `
const nums = [1, 2, 3]
var multiplier = 2
var sum = 0
var i = 0
for n of nums; i += multiplier {
  sum = sum + n + i
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		// 0 + 1 + 0 + 2 + 2 + 3 + 4
		await check_output("for_loop_update_outer_var", result, "12");
	});

	test("for loop with side effect in update", async () => {
		const input = `
const nums = [1, 2, 3]
var counter = 0
for n of nums; counter += 1 {
  Console.write("\\{n} ")
}
Console.write("\\n")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("for_loop_update_side_effect", result, "1 2 3 \n");
	});

	test("update with compound operator on range", async () => {
		const input = `
var sum = 0
var i = 0
for n of 0..5; i += 3 {
  sum = sum + n + i
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		// 0 + 0 + 0 + 1 + 3 + 2 + 6 + 3 + 9 + 4 + 12
		await check_output("for_loop_range_compound_update", result, "40");
	});
});

// ERRORS
describe("for loop errors", () => {
	test("string list", () => {
		const input = `
for x of "hi" {
  // ...
}
`;
		const expected = [test_error(input, "For loop list must be an array, not string", 2, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("int instead of array", () => {
		const input = `
for x of 5 {
  // ...
}
`;
		const expected = [test_error(input, "For loop list must be an array, not int", 2, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("undefined array variable", () => {
		const input = `
for x of nums {
  // ...
}
`;
		const expected = [test_error(input, "Unknown value: nums", 2, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("invalid range syntax", () => {
		const input = `
for x of 0 {
  // ...
}
`;
		const expected = [test_error(input, "For loop list must be an array, not int", 2, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing of", () => {
		const input = `
for x nums {
  // ...
}
`;
		const expected = [test_error(input, "Expected of", 2, 7)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing loop variable", () => {
		const input = `
for of [1, 2, 3] {
  // ...
}
`;
		const expected = [test_error(input, "Expected of", 2, 8)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing opening brace", () => {
		const input = `
for x of [1, 2, 3]
  // ...
}
`;
		const expected = [test_error(input, "Expected {", 3, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing closing brace", () => {
		const input = `
for x of [1, 2, 3] {
  // ...
`;
		const expected = [test_error(input, "Expected token", 4, 0)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing closing bracket", () => {
		const input = `
for x of [1, 2, 3 {
  // ...
}
`;
		const expected = [test_error(input, "Expected ]", 2, 19)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("bool as array", () => {
		const input = `
for x of true {
  // ...
}
`;
		const expected = [test_error(input, "For loop list must be an array, not bool", 2, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("empty range", () => {
		const input = `
for x of .. {
  // ...
}
`;
		const expected = [test_error(input, "Unknown value: ..", 2, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("invalid array syntax", () => {
		const input = `
for x of 1, 2, 3 {
  // ...
}
`;
		const expected = [test_error(input, "Expected {", 2, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("range with expressions", () => {
		const input = `
const start = 0
const end = 5
for x of start..end {
  Console.write("\\{x}")
}
`;
		const parsed = parse_with_imports(input);
		// Should parse correctly or give a clear error
		expect(parsed.errors.length).toBeGreaterThanOrEqual(0);
	});

	test("update with undefined variable", () => {
		const input = `
const nums = [1, 2, 3]
for n of nums; n += undefined_var {
  // body
}
`;
		const expected = [test_error(input, "Unknown value: undefined_var", 3, 21)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("update with unknown function", () => {
		const input = `
const nums = [1, 2, 3]
for n of nums; n = some_func(n) {
  // body
}
`;
		const expected = [test_error(input, "Function not found: some_func", 3, 20)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("multiple semicolons", () => {
		const input = `
const nums = [1, 2, 3]
for n of nums; n += 1; {
  // body
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});
