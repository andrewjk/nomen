import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import test_error from "./test_error";
import trim_test_build from "./trim_test_build";

// BUILD
describe("if/else build", () => {
  test("if", () => {
    const input = `
var x = 10
if x > 5 {
  x = 15
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .quad 10
ldr x2, =5
adr x0, x
ldr x0, [x0]
mov x1, x0
cmp x1, x2
cset x0, gt

cmp x0, #0
beq end_0
ldr x0, =15
adr x1, x
str x0, [x1]
end_0:
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("if else", () => {
    const input = `
var x = 10
if x > 5 {
  x = 15
} else {
  x = 20
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .quad 10
ldr x2, =5
adr x0, x
ldr x0, [x0]
mov x1, x0
cmp x1, x2
cset x0, gt

cmp x0, #0
beq else_0
ldr x0, =15
adr x1, x
str x0, [x1]
b end_0
else_0:
ldr x0, =20
adr x1, x
str x0, [x1]
end_0:
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("declaration with if", () => {
    const input = `
const x = 10
const y = if x > 5 {
  let 50
} else {
  let 0
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .quad 10
y: .space 8
ldr x2, =5
adr x0, x
ldr x0, [x0]
mov x1, x0
cmp x1, x2
cset x0, gt

cmp x0, #0
beq else_0
ldr x0, =50
adr x1, y
str x0, [x1]
b end_0
else_0:
ldr x0, =0
adr x1, y
str x0, [x1]
end_0:
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("declaration with one line if", () => {
    const input = `
const x = 10
const y = if x > 5 -> (50) else -> (0)
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .quad 10
y: .space 8
ldr x2, =5
adr x0, x
ldr x0, [x0]
mov x1, x0
cmp x1, x2
cset x0, gt

cmp x0, #0
beq else_0
ldr x0, =50
adr x1, y
str x0, [x1]
b end_0
else_0:
ldr x0, =0
adr x1, y
str x0, [x1]
end_0:
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("declaration with one line if with operation", () => {
    const input = `
const x = 10
const y = if x > 5 -> (x + 1) else -> (x - 1)
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .quad 10
y: .space 8
ldr x2, =5
adr x0, x
ldr x0, [x0]
mov x1, x0
cmp x1, x2
cset x0, gt

cmp x0, #0
beq else_0
ldr x2, =1
adr x0, x
ldr x0, [x0]
mov x1, x0
add x0, x1, x2
adr x1, y
str x0, [x1]
b end_0
else_0:
ldr x2, =1
adr x0, x
ldr x0, [x0]
mov x1, x0
sub x0, x1, x2
adr x1, y
str x0, [x1]
end_0:
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("if without else", () => {
    const input = `
var x = 10
if x > 5 {
  x = 15
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .quad 10
ldr x2, =5
adr x0, x
ldr x0, [x0]
mov x1, x0
cmp x1, x2
cset x0, gt

cmp x0, #0
beq end_0
ldr x0, =15
adr x1, x
str x0, [x1]
end_0:
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("if/else errors", () => {
  test("string condition", () => {
    const input = `
if "hi" {
  // ...
}
`;
    const expected = [test_error(input, "If/else condition must be a bool, not string", 2, 4)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
