import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("function build", () => {
  test("function", () => {
    const input = `
func add = () -> {}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
add:
stp x29, x30, [sp, #-16]!
mov x29, sp
.return_0:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function with params", () => {
    const input = `
func add = (int a, int b) -> {}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
add:
stp x29, x30, [sp, #-16]!
mov x29, sp
.return_1:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function with params with default value", () => {
    const input = `
func add = (int a, b = 5) -> {}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
add:
stp x29, x30, [sp, #-16]!
mov x29, sp
.return_2:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function with return type", () => {
    const input = `
func add = (out int) -> {
  return 5
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
add:
stp x29, x30, [sp, #-16]!
mov x29, sp
ldr x0, =5
b .return_3
.return_3:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function with body", () => {
    const input = `
func add = () -> {
  var x = 5
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
add:
stp x29, x30, [sp, #-16]!
mov x29, sp
x: .quad 5
.return_4:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function with return value", () => {
    const input = `
func add = (out int) -> {
  return 5
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
add:
stp x29, x30, [sp, #-16]!
mov x29, sp
ldr x0, =5
b .return_5
.return_5:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function with typed param and default value", () => {
    const input = `
func add = (int a = 5) -> {}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
add:
stp x29, x30, [sp, #-16]!
mov x29, sp
.return_6:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function with var param", () => {
    const input = `
func add = (var int a) -> {}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
add:
stp x29, x30, [sp, #-16]!
mov x29, sp
.return_7:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("function with params and return", () => {
    const input = `
func add = (int a, out int) -> {
  return a
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
add:
stp x29, x30, [sp, #-16]!
mov x29, sp
b .return_8
.return_8:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("one-line return", () => {
    const input = `
func sum = (int a, int b, out int) -> (a + b)
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
sum:
stp x29, x30, [sp, #-16]!
mov x29, sp
mov x2, x1
mov x1, x0
add x0, x1, x2
b .return_9
.return_9:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("var function without body", () => {
    const input = `
var func (int a, int b, out int) sum
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
sum: .space 8
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("var function with body", () => {
    const input = `
var func (int a, int b, out int) sum = (int a, int b, out int) -> {
  return a + b
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
sum:
stp x29, x30, [sp, #-16]!
mov x29, sp
mov x2, x1
mov x1, x0
add x0, x1, x2
b .return_10
.return_10:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
})

// ERRORS
describe("function errors", () => {
  test("unknown param type", () => {
    const input = `
func add = (what a) -> {}
`;
    const expected = [test_error(input, "Unknown type: what", 2, 13)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("unknown param value type", () => {
    const input = `
func add = (a = z0) -> {}
`;
    const expected = [test_error(input, "Unknown value: z0", 2, 17)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("param type mismatch", () => {
    const input = `
func add = (int a = "string?!") -> {}
`;
    const expected = [
      test_error(input, "Type mismatch in param default: string (expected int)", 2, 21),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("param type mismatch - unknown value", () => {
    const input = `
func add = (int a = z0) -> {}
`;
    const expected = [test_error(input, "Unknown value: z0", 2, 21)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("no param type or default value", () => {
    const input = `
func add = (a) -> {}
`;
    const expected = [test_error(input, "Expected type or default value", 2, 13)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("unknown return value type", () => {
    const input = `
func add = (out what) -> {
  return 5
}
`;
    const expected = [test_error(input, "Unknown type: what", 2, 17)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("return type mismatch", () => {
    const input = `
func add = (out int) -> {
  return "string?!"
}
`;
    const expected = [test_error(input, "Type mismatch in return: string (expected int)", 3, 10)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("return type mismatch - unknown value", () => {
    const input = `
func add = (out int) -> {
  return z0
}
`;
    const expected = [test_error(input, "Unknown value: z0", 3, 10)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("missing return", () => {
    const input = `
func add = (out int) -> {}
`;
    const expected = [test_error(input, "Missing return", 2, 26)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("one-line return type mismatch", () => {
    const input = `
func add = (out int) -> ("string")
`;
    const expected = [
      test_error(input, "Type mismatch in return: string (expected int)", 2, 26),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("one-line return unknown value", () => {
    const input = `
func add = (out int) -> (z0)
`;
    const expected = [test_error(input, "Unknown value: z0", 2, 26)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
