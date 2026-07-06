import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// BUILD
describe("custom operator build", () => {
	test("add operator on struct", async () => {
		const input = `
struct Point {
  var int x
  var int y
  pub func #op_add = (self, Point other, out Point) {
    return Point(self.x + other.x, self.y + other.y)
  }
}
const p1 = Point(1, 2)
const p2 = Point(3, 4)
const p3 = p1 + p2
Console.write("\\{p3.x} \\{p3.y}")
`;
		await build_and_check_output(input, "op_add_struct", "4 6");
	});

	test("multiply operator on struct", async () => {
		const input = `
struct Point {
  var int x
  var int y
  pub func #op_mul = (self, int scalar, out Point) {
    return Point(self.x * scalar, self.y * scalar)
  }
}
const p1 = Point(2, 3)
const p2 = p1 * 4
Console.write("\\{p2.x} \\{p2.y}")
`;
		await build_and_check_output(input, "op_mul_struct", "8 12");
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
  func #op_add = (self, Point other, out Point) {
    return Point(self.x + other.x, self.y + other.y)
  }
}
const p1 = Point(1, 2)
const p3 = p1 + 5
`;
		const expected = Array(
			test_error(input, "Type mismatch in param: int (expected Point)", 10, 17),
		);
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
