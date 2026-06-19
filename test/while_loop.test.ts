import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("while loop build", () => {
	test("while with output", async () => {
		const input = `
var x = 0
while x < 3 {
  Console.write("\\{x} ")
  x = x + 1
}
Console.write("\\n")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("while_loop_with_output", result, "0 1 2 \n");
	});

	test("while with greater than", async () => {
		const input = `
var x = 5
while x > 0 {
  x = x - 1
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("while_loop_greater_than", result, "0");
	});

	test("while with equality", async () => {
		const input = `
var x = 0
while x != 3 {
  x = x + 1
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("while_loop_equality", result, "3");
	});

	test("while with nested loops", async () => {
		const input = `
var i = 0
var total = 0
while i < 3 {
  var j = 0
  while j < 2 {
    total = total + 1
    j = j + 1
  }
  i = i + 1
}
Console.write("\\{total}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("while_loop_nested", result, "6");
	});

	test("while with update clause", async () => {
		const input = `
var x = 0
var counter = 0
while x < 3; counter += 1 {
  x = x + 1
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("while_loop_update_clause", result, "3");
	});

	test("while with increment in update", async () => {
		const input = `
var x = 0
while x < 3; x += 1 {
  Console.write("\\{x} ")
}
Console.write("\\n")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("while_loop_increment_update", result, "0 1 2 \n");
	});

	test("while with modulo", async () => {
		const input = `
var x = 0
var sum = 0
while x < 10 {
  if x % 2 == 0 {
    sum = sum + x
  }
  x = x + 1
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("while_loop_modulo", result, "20");
	});

	test("while with break", async () => {
		const input = `
var x = 0
while true {
  x = x + 1
  if x >= 5 {
    break
  }
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("while_loop_break", result, "5");
	});

	test("while with continue", async () => {
		const input = `
var x = 0
while x < 10 {
  x = x + 1
  if x % 2 == 0 {
    continue
  }
  x = x * 2
}
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("while_loop_continue", result, "14");
	});
});

// ERRORS
describe("while loop errors", () => {
	test("string condition", () => {
		const input = `
while "hi" {
  // ...
}
`;
		const expected = [test_error(input, "While loop condition must be a bool, not string", 2, 7)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("int condition", () => {
		const input = `
while 5 {
  // ...
}
`;
		const expected = [test_error(input, "While loop condition must be a bool, not int", 2, 7)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing opening brace", () => {
		const input = `
while x < 5
  // ...
}
`;
		const expected = [test_error(input, "Expected {", 4, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing closing brace", () => {
		const input = `
while x < 5 {
  // ...
}
`;
		const expected = [
			test_error(input, "Unknown value: x", 2, 7),
			test_error(input, "While loop condition must be a bool, not ", 2, 7),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("missing closing brace", () => {
		const input = `
while x < 5 {
  // ...
`;
		const expected = [test_error(input, "Expected token", 3, 0)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("empty condition", () => {
		const input = `
while {
  // ...
}
`;
		const expected = [test_error(input, "Expected {", 4, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("update with undefined variable", () => {
		const input = `
var x = 0
while x < 3; x += undefined_var {
  // body
}
`;
		const expected = [test_error(input, "Unknown value: undefined_var", 3, 19)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("update with unknown function", () => {
		const input = `
var x = 0
while x < 3; x = some_func(x) {
  // body
}
`;
		const expected = [test_error(input, "Function not found: some_func", 3, 18)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("multiple semicolons", () => {
		const input = `
var x = 0
while x < 3; x += 1; {
  // body
}
`;
		const expected = [test_error(input, "Expected {", 3, 19)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("invalid syntax in condition", () => {
		const input = `
while x + 1 > 5 {
  // ...
}
`;
		const expected = [
			test_error(input, "Unknown value: x", 2, 7),
			test_error(input, "While loop condition must be a bool, not ", 2, 7),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("update without assignment", () => {
		const input = `
var x = 0
var counter = 0
while x < 3; x + 1 {
  // body
}
Console.write("\\{counter}")
`;
		const expected = [test_error(input, "Unknown value: Console", 7, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("update with division by zero in condition", () => {
		const input = `
while 1 / 0 {
  // ...
}
`;
		const expected = [test_error(input, "While loop condition must be a bool, not int", 2, 7)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
