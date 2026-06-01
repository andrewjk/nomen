import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("custom operator build", () => {
	test("add operator on struct", async () => {
		const input = `
struct Point {
  var int x
  var int y
  pub op + (self, Point other, out Point) {
    return Point(self.x + other.x, self.y + other.y)
  }
}
const p1 = Point(1, 2)
const p2 = Point(3, 4)
const p3 = p1 + p2
Console.write("\\{p3.x} \\{p3.y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("op_add_struct", result, "4 6");
	});

	test("multiply operator on struct", async () => {
		const input = `
struct Point {
  var int x
  var int y
  pub op * (self, int scalar, out Point) {
    return Point(self.x * scalar, self.y * scalar)
  }
}
const p1 = Point(2, 3)
const p2 = p1 * 4
Console.write("\\{p2.x} \\{p2.y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("op_mul_struct", result, "8 12");
	});
});

// ERRORS
describe("custom operator errors", () => {
	test("operator function not found", () => {
		const input = `
struct Point {
  var int x
  var int y
}
const p1 = Point(1, 2)
const p2 = Point(3, 4)
const p3 = p1 + p2
`;
		const expected = [test_error(input, "No operator + defined for type Point", 8, 12)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("operator param type mismatch", () => {
		const input = `
struct Point {
  var int x
  var int y
  op + (self, Point other, out Point) {
    return Point(self.x + other.x, self.y + other.y)
  }
}
const p1 = Point(1, 2)
const p3 = p1 + 5
`;
		const expected = [test_error(input, "Type mismatch in param: int (expected Point)", 10, 17)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
