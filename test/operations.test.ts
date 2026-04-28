import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import test_error from "./test_error";
import trim_test_build from "./trim_test_build";

// BUILD
describe("operation build", () => {
  test("addition", () => {
    const input = `
var x = 1 + 2
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .space 8
ldr x2, =2
ldr x1, =1
add x0, x1, x2
adr x1, x
str x0, [x1]
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("subtraction", () => {
    const input = `
var x = 1 - 2
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .space 8
ldr x2, =2
ldr x1, =1
sub x0, x1, x2
adr x1, x
str x0, [x1]
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("series", () => {
    const input = `
var x = 1 + 2 - 3
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .space 8
ldr x2, =3
ldr x1, =2
sub x0, x1, x2
mov x2, x0
ldr x1, =1
add x0, x1, x2
adr x1, x
str x0, [x1]
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("multiplication", () => {
    const input = `
var x = 3 * 4
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .space 8
ldr x2, =4
ldr x1, =3
mul x0, x1, x2
adr x1, x
str x0, [x1]
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("division", () => {
    const input = `
var x = 10 / 2
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .space 8
ldr x2, =2
ldr x1, =10
sdiv x0, x1, x2
adr x1, x
str x0, [x1]
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("operator precedence", () => {
    const input = `
var x = 1 + 2 * 3
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .space 8
ldr x2, =3
ldr x1, =2
mul x0, x1, x2
mov x2, x0
ldr x1, =1
add x0, x1, x2
adr x1, x
str x0, [x1]
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("grouped precedence", () => {
    const input = `
var x = (1 + 2) * 3
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .space 8
ldr x2, =3
str x2, [sp, #-16]!
ldr x2, =2
ldr x1, =1
add x0, x1, x2
mov x1, x0
ldr x2, [sp], #16
mul x0, x1, x2
adr x1, x
str x0, [x1]
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("operation errors", () => {
  test("type mismatch", () => {
    const input = `
const x = 5 + "b"
`;
    const expected = [
      test_error(input, "Type mismatch in operation: string (expected int)", 2, 15),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("declaration type mismatch", () => {
    const input = `
const int x = "a" + "b"
`;
    const expected = [
      test_error(input, "Type mismatch in declaration: string (expected int)", 2, 15),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("assignment type mismatch", () => {
    const input = `
var int x
x = "a" + "b"
`;
    const expected = [
      test_error(input, "Type mismatch in assignment: string (expected int)", 3, 5),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
