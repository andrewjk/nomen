import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("control build", () => {
	test("if true", async () => {
		const input = `
var int x = 0
if true {
  x = 1
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_if_true", result, "1");
	});

	test("if false", async () => {
		const input = `
var int x = 0
if false {
  x = 1
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_if_false", result, "0");
	});

	test("if else true", async () => {
		const input = `
var int x = 0
if true {
  x = 1
} else {
  x = 2
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_if_else_true", result, "1");
	});

	test("if else false", async () => {
		const input = `
var int x = 0
if false {
  x = 1
} else {
  x = 2
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_if_else_false", result, "2");
	});

	test("if with condition", async () => {
		const input = `
const a = 5
var int result = 0
if a > 3 {
  result = 1
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_if_condition", result, "1");
	});

	test("if else with condition", async () => {
		const input = `
const a = 2
var int result = 0
if a > 3 {
  result = 1
} else {
  result = 2
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_if_else_condition", result, "2");
	});

	test("for loop with break", async () => {
		const input = `
var int sum = 0
for i of 0..10 {
  if i == 5 {
    break
  }
  sum = sum + i
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_for_break", result, "10");
	});

	test("for loop with continue", async () => {
		const input = `
var int sum = 0
for i of 0..5 {
  if i == 2 {
    continue
  }
  sum = sum + i
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_for_continue", result, "8");
	});

	test("while loop", async () => {
		const input = `
var int x = 0
var int count = 0
while x < 5 {
  x = x + 1
  count = count + 1
}
Console.write("\\{count}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_while", result, "5");
	});

	test("while loop with break", async () => {
		const input = `
var int x = 0
while true {
  if x == 3 {
    break
  }
  x = x + 1
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_while_break", result, "3");
	});

	test("while loop with update clause", async () => {
		const input = `
var int x = 0
var int sum = 0
while x < 5; x = x + 1 {
  sum = sum + x
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_while_update", result, "10");
	});

	test("for loop iterating array", async () => {
		const input = `
const arr = Array(10, 20, 30)
var int sum = 0
for item of arr {
  sum = sum + item
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_for_array", result, "60");
	});

	test("for loop with index array access", async () => {
		const input = `
const arr = Array(10, 20, 30)
var int sum = 0
for i of 0..3 {
  sum = sum + arr.at(i)
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_for_index_array", result, "60");
	});

	test("nested loops", async () => {
		const input = `
var int count = 0
for i of 0..3 {
  for j of 0..2 {
    count = count + 1
  }
}
Console.write("\\{count}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_nested_loops", result, "6");
	});

	test("if else with comparison operators", async () => {
		const input = `
var int result = 0
if 3 >= 3 {
  result = result + 1
}
if 3 <= 3 {
  result = result + 1
}
if 4 != 3 {
  result = result + 1
}
if 3 == 3 {
  result = result + 1
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_comparisons", result, "4");
	});

	test("logical operators in conditions", async () => {
		const input = `
var int result = 0
if true && true {
  result = result + 1
}
if true && false {
  result = result + 10
}
if false || true {
  result = result + 1
}
if false || false {
  result = result + 10
}
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("control_logical_ops", result, "2");
	});

	test("panic outputs message", () => {
		const input = `
func crash = (out int) {
  panic("something went wrong")
}
crash()
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		expect(result.code).toContain("something went wrong");
	});

	test("todo outputs message", () => {
		const input = `
func incomplete = (out int) {
  todo("not done yet")
}
incomplete()
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		expect(result.code).toContain("not done yet");
	});
});

// ERRORS
describe("control errors", () => {
	test("break outside loop", () => {
		const input = `
func add = (out int) {
  break
  return 5
}
`;
		const expected = [test_error(input, "Break must be inside a for or while loop", 3, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("continue outside loop", () => {
		const input = `
func add = (out int) {
  continue
  return 5
}
`;
		const expected = [test_error(input, "Continue must be inside a for or while loop", 3, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("panic without a message", () => {
		const input = `
func add = (out int) {
  panic
}
`;
		const expected = [test_error(input, "Expected a panic message", 4, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("todo without a message", () => {
		const input = `
func add = (out int) {
  todo
}
`;
		const expected = [test_error(input, "Expected a todo message", 4, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
