import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import test_error from "./test_error";
import trim_test_build from "./trim_test_build";

// BUILD
describe("while loop build", () => {
	test("while", () => {
		const input = `
var x = 0
while x < 5 {
  x = x + 1
}
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
x: .quad 0
.while_0:
ldr x2, =5
adr x0, x
ldr x0, [x0]
mov x1, x0
cmp x1, x2
cset x0, lt
cmp x0, #0
beq .end_while_0
ldr x2, =1
adr x0, x
ldr x0, [x0]
mov x1, x0
add x0, x1, x2

adr x1, x
str x0, [x1]
b .while_0
.end_while_0:
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});

	test("while true", () => {
		const input = `
while true {
  // ...
}
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
.while_0:
ldr x0, =1
cmp x0, #0
beq .end_while_0
b .while_0
.end_while_0:
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});

	test("while with break", () => {
		const input = `
var x = 0
while true {
  x = x + 1
  if x >= 5 {
    break
  }
}
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
x: .quad 0
.while_0:
ldr x0, =1
cmp x0, #0
beq .end_while_0
ldr x2, =1
adr x0, x
ldr x0, [x0]
mov x1, x0
add x0, x1, x2

adr x1, x
str x0, [x1]
ldr x2, =5
adr x0, x
ldr x0, [x0]
mov x1, x0
cmp x1, x2
cset x0, ge

cmp x0, #0
beq end_0
b .end_while_0
end_0:
b .while_0
.end_while_0:
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});

	test("while with continue", () => {
		const input = `
var x = 0
while x < 10 {
  x = x + 1
  if x % 2 == 0 {
    continue
  }
  x = x * 2
}
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
x: .quad 0
.while_0:
ldr x2, =10
adr x0, x
ldr x0, [x0]
mov x1, x0
cmp x1, x2
cset x0, lt
cmp x0, #0
beq .end_while_0
ldr x2, =1
adr x0, x
ldr x0, [x0]
mov x1, x0
add x0, x1, x2

adr x1, x
str x0, [x1]
ldr x2, =0
str x2, [sp, #-16]!
ldr x2, =2
adr x0, x
ldr x0, [x0]
mov x1, x0
sdiv x3, x1, x2
msub x0, x3, x2, x1
mov x1, x0
ldr x2, [sp], #16
cmp x1, x2
cset x0, eq

cmp x0, #0
beq end_0
b .while_0
end_0:
ldr x2, =2
adr x0, x
ldr x0, [x0]
mov x1, x0
mul x0, x1, x2

adr x1, x
str x0, [x1]
b .while_0
.end_while_0:
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
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
});
