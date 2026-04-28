import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("control build", () => {
  test("break", () => {
    const input = `
for x in 0..5 {
  break
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
b .end_0
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

  test("continue", () => {
    const input = `
for x in 0..5 {
  continue
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
b .for_0
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

  test("panic", () => {
    const input = `
func add = (out int) -> {
  panic("something went wrong")
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
add:
stp x29, x30, [sp, #-16]!
mov x29, sp
adr x0, _str_panic_something_went_wrong
bl printf
mov x0, #1
bl exit
.return_0:
ldp x29, x30, [sp], #16
ret

_str_panic_something_went_wrong: .asciz "something went wrong\\n"
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("todo", () => {
    const input = `
func add = (out int) -> {
  todo("haven't done this yet")
}
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
.p2align 2
add:
stp x29, x30, [sp, #-16]!
mov x29, sp
adr x0, _str_todo_haven_t_done_this_yet
bl printf
mov x0, #1
bl exit
.return_0:
ldp x29, x30, [sp], #16
ret

_str_todo_haven_t_done_this_yet: .asciz "haven't done this yet\\n"
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("control errors", () => {
  test("break outside loop", () => {
    const input = `
func add = (out int) -> {
  break
  return 5
}
`;
    const expected = [test_error(input, "Break must be inside a for or while loop", 3, 3)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("continue outside loop", () => {
    const input = `
func add = (out int) -> {
  continue
  return 5
}
`;
    const expected = [test_error(input, "Continue must be inside a for or while loop", 3, 3)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("panic without a message", () => {
    const input = `
func add = (out int) -> {
  panic
}
`;
    const expected = [test_error(input, "Expected a panic message", 4, 1)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("todo without a message", () => {
    const input = `
func add = (out int) -> {
  todo
}
`;
    const expected = [test_error(input, "Expected a todo message", 4, 1)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
