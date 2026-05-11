import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import test_error from "./test_error";
import trim_test_build from "./trim_test_build";

// BUILD
describe("for loop build", () => {
	test("with array", () => {
		const input = `
const y = [1, 2, 3]
for x in y {
  x = x + 1
}
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
y: .quad 1, 2, 3
.p2align 2
ldr x0, =0
adr x1, _idx_x
str x0, [x1]
.for_0:
adr x0, _idx_x
ldr x0, [x0]
mov x2, x0
ldr x0, =3
cmp x2, x0
bge .end_0
adr x3, y
adr x1, _idx_x
ldr x1, [x1]
mov x2, #8
mul x1, x1, x2
add x0, x3, x1
ldr x0, [x0]
adr x1, x
str x0, [x1]
ldr x2, =1
adr x0, x
ldr x0, [x0]
mov x1, x0
add x0, x1, x2

adr x1, x
str x0, [x1]
adr x0, _idx_x
ldr x0, [x0]
add x0, x0, #1
adr x1, _idx_x
str x0, [x1]
b .for_0
.end_0:
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});

	test("with range", () => {
		const input = `
for x in 0..5 {
  x = x + 1
}
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
ldr x0, =0
adr x1, x
str x0, [x1]
.for_0:
adr x0, x
ldr x0, [x0]
mov x2, x0
ldr x0, =5
cmp x2, x0
bge .end_0
ldr x2, =1
adr x0, x
ldr x0, [x0]
mov x1, x0
add x0, x1, x2

adr x1, x
str x0, [x1]
adr x0, x
ldr x0, [x0]
add x0, x0, #1
adr x1, x
str x0, [x1]
b .for_0
.end_0:
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});

	test("with body", () => {
		const input = `
const nums = [1, 2, 3]
var sum = 0
for n in nums {
  sum = sum + n
}
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
nums: .quad 1, 2, 3
.p2align 2
sum: .quad 0
ldr x0, =0
adr x1, _idx_n
str x0, [x1]
.for_0:
adr x0, _idx_n
ldr x0, [x0]
mov x2, x0
ldr x0, =3
cmp x2, x0
bge .end_0
adr x3, nums
adr x1, _idx_n
ldr x1, [x1]
mov x2, #8
mul x1, x1, x2
add x0, x3, x1
ldr x0, [x0]
adr x1, n
str x0, [x1]
adr x0, n
ldr x0, [x0]
mov x2, x0
adr x0, sum
ldr x0, [x0]
mov x1, x0
add x0, x1, x2

adr x1, sum
str x0, [x1]
adr x0, _idx_n
ldr x0, [x0]
add x0, x0, #1
adr x1, _idx_n
str x0, [x1]
b .for_0
.end_0:
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});
});

// ERRORS
describe("for loop errors", () => {
	test("string list", () => {
		const input = `
for x in "hi" {
  // ...
}
`;
		const expected = [test_error(input, "For loop list must be an array, not string", 2, 10)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
