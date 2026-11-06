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

	test("operator with call operands", async () => {
		// A call operand clobbers the ABI's indirect-result register (x8), so
		// the aarch64 operator call must re-establish its own result sret
		// buffer after operand evaluation — otherwise the operator writes its
		// result into the operand call's temp (the `p + mk(...)` corruption).
		const input = `
struct Point {
  var int x
  var int y
  pub func #op_add = (self, Point other, out Point) {
    return Point(self.x + other.x, self.y + other.y)
  }
}

func mk = (int x, int y, out Point) {
  return Point(x, y)
}

var p = mk(1, 2)
var q = p + mk(10, 20)
var r = mk(100, 200) + mk(1000, 2000)
Console.write("\\{q.x} \\{q.y} \\{r.x} \\{r.y}")
`;
		await build_and_check_output(input, "op_call_operands", "11 22 1100 2200");
	});

	test("compound operator with a call operand", async () => {
		const input = `
struct Point {
  var int x
  var int y
  pub func #op_add = (self, Point other, out Point) {
    return Point(self.x + other.x, self.y + other.y)
  }
}

func mk = (int x, int y, out Point) {
  return Point(x, y)
}

var p = mk(1, 2)
p += mk(10, 20)
Console.write("\\{p.x} \\{p.y}")
`;
		await build_and_check_output(input, "op_call_operand_compound", "11 22");
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

	test("scalar float /= after a literal initializer", async () => {
		// The literal initializer's store must not be elided when the
		// assignment reads the slot back (`var float f = 7.5` followed by
		// `f = f / 2.5` / `f /= 2.5` used to divide the uninitialized slot).
		const input = `
var float f = 7.5
f = f / 2.5
Console.write("\\{f} ")
var float g = 7.5
g /= 2.5
Console.write("\\{g}")
`;
		await build_and_check_output(input, "op_scalar_float_div_compound", "3.000000 3.000000");
	});

	test("scalar float % and %= lower to fmod", async () => {
		// AArch64 has no scalar remainder instruction and C has no `%` on
		// doubles, so both backs lower a float remainder to the libm `fmod`
		// (truncated semantics — the sign follows the dividend, like the
		// integer `%`).
		const input = `
var float a = 17.5 % 5.0
Console.write("\\{a} ")
var float f = 17.5
f %= 5.0
Console.write("\\{f} ")
var float b = -17.5
var float c = 5.0
Console.write("\\{b % c} \\{(-b) % c}")
`;
		await build_and_check_output(
			input,
			"op_scalar_float_mod",
			"2.500000 2.500000 -2.500000 2.500000",
		);
	});

	test("float % with call operands and nesting", async () => {
		// `fmod` is a call, so it is excluded from the call-free float
		// expression tree; the operand evaluation must still spill safely
		// around call-bearing operands and nested trees.
		const input = `
func half = (float v, out float) { return v / 2.0 }
var float a = half(17.5) % 5.0
var float b = 17.5 % half(5.0)
var float c = (17.5 % 5.0) + 1.0
var float d = 10.0 / (17.5 % 5.0)
Console.write("\\{a} \\{b} \\{c} \\{d}")
`;
		await build_and_check_output(
			input,
			"op_scalar_float_mod_exprs",
			"3.750000 0.000000 3.500000 4.000000",
		);
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
