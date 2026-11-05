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

// COMPOUND ASSIGNMENT — routes to the same operator functions as the binary
// form (SPEC, Operator Functions). The struct forms and the scalar divide/
// remainder have no raw compound store on either backend (the aarch64
// compound store only has add/sub/mul arms), so check_assignment_node
// rewrites them into the explicit `x = x op y` spelling — the exact AST the
// hand-written form parses into — and the tested binary lowerings do the
// work. Scalars keep the raw store for `+=`/`-=`/`*=`.
describe("compound assignment operator dispatch", () => {
	test("struct %= routes to #op_mod", async () => {
		const input = `
struct Point {
  var int x
  var int y
  pub func #op_mod = (self, Point other: other.x != 0 && other.y != 0, out Point) {
    return Point(self.x % other.x, self.y % other.y)
  }
}
var p1 = Point(10, 17)
var p2 = Point(3, 5)
p1 %= p2
Console.write("\\{p1.x} \\{p1.y}")
`;
		await build_and_check_output(input, "op_mod_compound_struct", "1 2");
	});

	test("struct += routes to #op_add", async () => {
		const input = `
struct Point {
  var int x
  var int y
  pub func #op_add = (self, Point other, out Point) {
    return Point(self.x + other.x, self.y + other.y)
  }
}
var p1 = Point(1, 2)
var p2 = Point(10, 20)
p1 += p2
Console.write("\\{p1.x} \\{p1.y}")
`;
		await build_and_check_output(input, "op_add_compound_struct", "11 22");
	});

	test("scalar /= and %=", async () => {
		const input = `
var int x = 10
x /= 3
Console.write("\\{x} ")
var int y = 17
y %= 5
Console.write(y.to_string())
`;
		await build_and_check_output(input, "op_scalar_divmod_compound", "3 2");
	});

	test("no operator function: struct %= is a check error", () => {
		const input = `
struct Point {
  var int x
  var int y
}
var p1 = Point(1, 2)
var p2 = Point(3, 4)
p1 %= p2
`;
		const expected = [test_error(input, "No operator % defined for type Point", 8, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
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
