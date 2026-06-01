import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("if/else build", () => {
	test("if statement", async () => {
		const input = `
var x = 10
if x > 5 {
  x = 15
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_if_statement", result, "15");
	});

	test("if else statement", async () => {
		const input = `
var x = 10
if x > 5 {
  x = 15
} else {
  x = 20
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_if_else_statement", result, "15");
	});

	test("if else expression", async () => {
		const input = `
const x = 10
const y = if x > 5 {
  let 50
} else {
  let 0
}
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_if_else_expression", result, "50");
	});

	test("if else expression with arrows", async () => {
		const input = `
const x = 10
const y = if x > 5 {
  -> 50
} else {
  -> 0
}
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_if_else_expression", result, "50");
	});

	test("medium if else expression", async () => {
		const input = `
const x = 10
const y = if x > 5 let 50 else let 0
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_medium_if_else_expression", result, "50");
	});

	test("medium if else expression with statements", async () => {
		const input = `
const x = 10
const y = if x > 5 let (x + 1) else let x - 1
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_if_else_short_expression", result, "11");
	});

	test("short if else expression", async () => {
		const input = `
const x = 10
const y = if x > 5 -> 50 else -> 0
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_short_if_else_expression", result, "50");
	});

	test("short if else expression with statements", async () => {
		const input = `
const x = 10
const y = if x > 5 -> x + 1 else -> (x - 1)
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_if_else_short_expression", result, "11");
	});

	test("nested if/else", async () => {
		const input = `
var x = 10
var y = 5
if x > 5 {
  if y > 3 {
    x = 15
  } else {
    x = 20
  }
} else {
  x = 25
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_nested", result, "15");
	});

	test("less than", async () => {
		const input = `
var x = 3
if x < 5 {
  x = 10
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_less_than", result, "10");
	});

	test("less than or equal", async () => {
		const input = `
var x = 5
if x <= 5 {
  x = 10
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_less_than_equal", result, "10");
	});

	test("greater than or equal", async () => {
		const input = `
var x = 10
if x >= 10 {
  x = 20
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_greater_than_equal", result, "20");
	});

	test("equal", async () => {
		const input = `
var x = 5
if x == 5 {
  x = 10
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_equal", result, "10");
	});

	test("not equal", async () => {
		const input = `
var x = 5
if x != 3 {
  x = 10
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_not_equal", result, "10");
	});

	test("let in if, -> in else", async () => {
		const input = `
const x = 10
const y = if x > 5 { let 50 } else { -> 0 }
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_let_arrow_mixed", result, "50");
	});

	test("if else expression with false", async () => {
		const input = `
const x = 3
const y = if x > 5 let 50 else let 0
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_expression_false", result, "0");
	});

	test("if else expression with parentheses", async () => {
		const input = `
const x = 10
const y = if (x > 5) -> 50 else -> 0
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("if_else_expression_parens", result, "50");
	});
});

// ERRORS
describe("if/else errors", () => {
	test("string condition", () => {
		const input = `
if "hi" {
  // ...
}
`;
		const expected = [test_error(input, "If/else condition must be a bool, not string", 2, 4)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("int condition", () => {
		const input = `
if 5 {
  // ...
}
`;
		const expected = [test_error(input, "If/else condition must be a bool, not int", 2, 4)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("no else in declaration expression", () => {
		const input = `
const ex = if true {
  let 5
}
`;
		const expected = [test_error(input, "If expression must have an else branch", 2, 12)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing closing brace", () => {
		const input = `
if true {
  const x = 5
`;
		const expected = [test_error(input, "Expected token", 4, 0)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing closing parenthesis", () => {
		const input = `
const x = true
const y = if (x > 5 -> 50 else -> 0
`;
		const expected = [test_error(input, "Expected )", 3, 21)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("empty condition", () => {
		const input = `
if {
  // ...
}
`;
		const expected = [test_error(input, "Expected {", 3, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("multiple conditions", () => {
		const input = `
if true false {
  // ...
}
`;
		const expected = [test_error(input, "Expected {", 2, 9)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("const set in one branch only", () => {
		const input = `
const x = true
if x {
  const y = 5
} else {
  const z = 10
}
const a = y + z
`;
		const expected = [test_error(input, "Unknown value: y", 8, 11)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
