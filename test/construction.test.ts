import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import test_error from "./test_error";
import trim_test_build from "./trim_test_build";

// BUILD
describe("construction build", () => {
	test("init struct", () => {
		const input = `
struct Person {}
var x = Person()
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
.p2align 2
Person_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
.return_Person_init:
ldp x29, x30, [sp], #16
ret
x: .space 8
adr x0, x
bl Person_init
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});

	test("init struct with params", () => {
		const input = `
struct Person {
  var string name
}
var x = Person("Andrew")
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
.p2align 2
Person_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
.return_Person_init:
ldp x29, x30, [sp], #16
ret
x: .space 16
adr x0, _str_0
mov x1, x0
adr x0, x
bl Person_init

_str_0: .asciz "Andrew"
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});

	test("init struct with default field", () => {
		const input = `
struct Person {
  var string name
  var int age = 0
}
var x = Person("Andrew")
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
.p2align 2
Person_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
ldr x1, =0
str x1, [x0, #16]
.return_Person_init:
ldp x29, x30, [sp], #16
ret
x: .space 24
adr x0, _str_0
mov x1, x0
adr x0, x
bl Person_init

_str_0: .asciz "Andrew"
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});
});

// ERRORS
describe("construction errors", () => {
	test("struct not found", () => {
		const input = `
const dog = Dog()
`;
		const expected = [test_error(input, "Function not found: Dog", 2, 13)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("too many parameters", () => {
		const input = `
struct Dog {}
const dog = Dog("Spot")
`;
		const expected = [test_error(input, "Too many parameters for function: Dog", 3, 13)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("parameters missing", () => {
		const input = `
struct Dog {
  var string name
}
const dog = Dog()
`;
		const expected = [test_error(input, "Parameters missing for function: Dog", 5, 13)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("param type mismatch", () => {
		const input = `
struct Dog {
  var string name
}
const dog = Dog(5)
`;
		const expected = [test_error(input, "Type mismatch in param: int (expected string)", 5, 17)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("param type mismatch -- unknown value", () => {
		const input = `
struct Dog {
  var string name
}
const dog = Dog(z0)
`;
		const expected = [test_error(input, "Unknown value: z0", 5, 17)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
