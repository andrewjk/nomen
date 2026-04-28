import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import test_error from "./test_error";
import trim_test_build from "./trim_test_build";

// BUILD
describe("range build", () => {
  test("exclusive", () => {
    const input = `
var x = 1..4
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .quad 1, 2, 3
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("inclusive with expression", () => {
    const input = `
var x = 1..(4 + 1)
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .quad 1, 2, 3, 4
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("range with negative start", () => {
    const input = `
var x = -2..2
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
x: .quad -2, -1, 0, 1
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test.skip("range as param", () => {
    const input = `
func sum = (int[] nums, out int) -> {
  var total = 0
  for n in nums {
    total = total + n
  }
  return total
}
const result = sum(1..4)
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("range in for loop", () => {
    const input = `
func sum = (out int) -> {
  var total = 0
  for n in 1..4 {
    total = total + n
  }
  return total
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
sum:
stp x29, x30, [sp, #-16]!
sub sp, sp, #16
mov x29, sp
mov x0, #0
str x0, [x29, #0]
ldr x0, =1
str x0, [x29, #8]
.for_0:
ldr x0, [x29, #8]
mov x2, x0
ldr x0, =4
cmp x2, x0
bge .end_0
ldr x0, [x29, #8]
mov x2, x0
ldr x0, [x29, #0]
mov x1, x0
add x0, x1, x2

add x1, x29, #0
str x0, [x1]
ldr x0, [x29, #8]
add x0, x0, #1
str x0, [x29, #8]
b .for_0
.end_0:
ldr x0, [x29, #0]
b .return_0
.return_0:
add sp, sp, #16
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("range errors", () => {
  test("type mismatch", () => {
    const input = `
var x = 1.."b"
`;
    const expected = [test_error(input, "Type mismatch in range: string (expected int)", 2, 12)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
