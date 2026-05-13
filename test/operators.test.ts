import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import test_error from "./test_error";
import trim_test_build from "./trim_test_build";

// BUILD
describe("custom operator build", () => {
	test("add operator on struct", () => {
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
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
.p2align 2
Point_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
str x2, [x0, #16]
.return_Point_init:
ldp x29, x30, [sp], #16
ret
.p2align 2
Point_add:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
mov x29, sp
mov x0, x1
ldr x0, [x0, #8]
mov x2, x0
str x2, [sp, #-16]!
mov x0, x19
ldr x0, [x0, #8]
mov x1, x0
ldr x2, [sp], #16
add x0, x1, x2
str x0, [x29, #0]
mov x0, x1
ldr x0, [x0, #16]
mov x2, x0
str x2, [sp, #-16]!
mov x0, x19
ldr x0, [x0, #16]
mov x1, x0
ldr x2, [sp], #16
add x0, x1, x2
str x0, [x29, #8]
sub x0, x29, #16
ldr x0, [x29, #8]
mov x2, x0
ldr x0, [x29, #0]
mov x1, x0
bl Point_init
sub x0, x29, #16
b .return_Point_add
.return_Point_add:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
p1: .space 24
ldr x0, =2
mov x2, x0
ldr x0, =1
mov x1, x0
adr x0, p1
bl Point_init
p2: .space 24
ldr x0, =4
mov x2, x0
ldr x0, =3
mov x1, x0
adr x0, p2
bl Point_init
p3: .space 24
adr x1, p2
adr x0, p1
bl Point_add
mov x1, x0
adr x2, p3
ldr x3, [x1, #0]
str x3, [x2, #0]
ldr x3, [x1, #8]
str x3, [x2, #8]
ldr x3, [x1, #16]
str x3, [x2, #16]
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});

	test("multiply operator on struct", () => {
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
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
.p2align 2
Point_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
str x2, [x0, #16]
.return_Point_init:
ldp x29, x30, [sp], #16
ret
.p2align 2
Point_mul:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
mov x29, sp
mov x2, x1
str x2, [sp, #-16]!
mov x0, x19
ldr x0, [x0, #8]
mov x1, x0
ldr x2, [sp], #16
mul x0, x1, x2
str x0, [x29, #0]
mov x2, x1
str x2, [sp, #-16]!
mov x0, x19
ldr x0, [x0, #16]
mov x1, x0
ldr x2, [sp], #16
mul x0, x1, x2
str x0, [x29, #8]
sub x0, x29, #16
ldr x0, [x29, #8]
mov x2, x0
ldr x0, [x29, #0]
mov x1, x0
bl Point_init
sub x0, x29, #16
b .return_Point_mul
.return_Point_mul:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
p1: .space 24
ldr x0, =3
mov x2, x0
ldr x0, =2
mov x1, x0
adr x0, p1
bl Point_init
p2: .space 24
ldr x1, =4
adr x0, p1
bl Point_mul
mov x1, x0
adr x2, p2
ldr x3, [x1, #0]
str x3, [x2, #0]
ldr x3, [x1, #8]
str x3, [x2, #8]
ldr x3, [x1, #16]
str x3, [x2, #16]
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
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
