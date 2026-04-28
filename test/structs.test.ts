import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("struct build", () => {
  test("struct", () => {
    const input = `
struct Person {}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
Person_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
.return_Person_init:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("struct with fields", () => {
    const input = `
struct Person {
  var string name
  var age = 0
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
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
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("struct with functions", () => {
    const input = `
struct Person {
  func greet = () -> {}
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
Person_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
.return_Person_init:
ldp x29, x30, [sp], #16
ret
Person_greet:
stp x29, x30, [sp, #-16]!
mov x29, sp
.return_Person_greet:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("struct with mutating functions", () => {
    const input = `
struct Person {
  var int age = 0
  func grow = (var self) -> {
    self.age = self.age + 1
  }
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
Person_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
ldr x1, =0
str x1, [x0, #8]
.return_Person_init:
ldp x29, x30, [sp], #16
ret
Person_grow:
stp x29, x30, [sp, #-16]!
mov x29, sp
ldr x2, =1
str x2, [sp, #-16]!
ldr x0, [x0, #8]
mov x1, x0
ldr x2, [sp], #16
add x0, x1, x2
mov x2, x0
str x2, [x0, #8]
.return_Person_grow:
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("struct with function returning value", () => {
    const input = `
struct Person {
  var string name
  func get_name = (self, out string) -> {
    return self.name
  }
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
Person_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
.return_Person_init:
ldp x29, x30, [sp], #16
ret
Person_get_name:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
mov x29, sp
mov x0, x19
ldr x0, [x0, #8]
b .return_Person_get_name
.return_Person_get_name:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("struct errors", () => {
  test("invalid syntax", () => {
    const input = `
struct Person People {}
`;
    const expected = [test_error(input, "Expected {", 2, 15)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("child struct", () => {
    const input = `
struct Person {
  struct People {}
}
`;
    const expected = [test_error(input, "Struct cannot appear here", 3, 3)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("child assignment", () => {
    const input = `
struct Person {
  var int x
  x = 5
}
`;
    const expected = [test_error(input, "Assignment cannot appear here", 4, 3)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
