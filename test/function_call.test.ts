import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("function call build", () => {
  test("function without params", () => {
    const input = `
func greet = () -> {}
greet()
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
greet:
stp x29, x30, [sp, #-16]!
mov x29, sp
.return_0:
ldp x29, x30, [sp], #16
ret
bl greet
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function with params", () => {
    const input = `
func greet = (string name, string position) -> {}
greet("Andrew", "Manager")
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
greet:
stp x29, x30, [sp, #-16]!
mov x29, sp
.return_0:
ldp x29, x30, [sp], #16
ret
adr x0, _str_0
mov x1, x0
adr x0, _str_1
bl greet

_str_0: .asciz "Manager"
_str_1: .asciz "Andrew"
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function call with return value", () => {
    const input = `
func add = (int a, int b, out int) -> (a + b)
const x = add(1, 2)
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
add:
stp x29, x30, [sp, #-16]!
mov x29, sp
mov x2, x1
mov x1, x0
add x0, x1, x2
b .return_0
.return_0:
ldp x29, x30, [sp], #16
ret
x: .space 8
ldr x0, =2
mov x1, x0
ldr x0, =1
bl add
adr x1, x
str x0, [x1]
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function call with default param", () => {
    const input = `
func greet = (string name, string greeting = "Hello") -> {}
greet("Andrew")
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
greet:
stp x29, x30, [sp, #-16]!
mov x29, sp
.return_0:
ldp x29, x30, [sp], #16
ret
adr x0, _str_0
bl greet

_str_0: .asciz "Andrew"
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("function call errors", () => {
  test("function not found", () => {
    const input = `
greet()
`;
    const expected = [test_error(input, "Function not found: greet", 2, 1)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("too many parameters", () => {
    const input = `
func greet = (int first, int second) -> {}
greet(1, 2, 3)
`;
    const expected = [test_error(input, "Too many parameters for function: greet", 3, 1)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("parameters missing", () => {
    const input = `
func greet = (int first, int second) -> {}
greet(1)
`;
    const expected = [test_error(input, "Parameters missing for function: greet", 3, 1)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("param type mismatch", () => {
    const input = `
func greet = (int age) -> {}
greet("andrew")
`;
    const expected = [test_error(input, "Type mismatch in param: string (expected int)", 3, 7)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("param type mismatch -- unknown value", () => {
    const input = `
func greet = (int age) -> {}
greet(z0)
`;
    const expected = [test_error(input, "Unknown value: z0", 3, 7)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
