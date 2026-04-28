import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("access build", () => {
  test("getting field", () => {
    const input = `
struct Person {
  var int age
}
var Person p
var x = p.age
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
p: .space 16
x: .space 8
adr x0, p
ldr x0, [x0, #8]
adr x1, x
str x0, [x1]
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("getting nested field", () => {
    const input = `
struct Address {
  var string line
}
struct Person {
  var int age
  var Address address
}
var Person p
var x = p.address.line
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
Address_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
.return_Address_init:
ldp x29, x30, [sp], #16
ret
Person_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
str x2, [x0, #16]
.return_Person_init:
ldp x29, x30, [sp], #16
ret
p: .space 24
x: .space 8
adr x0, p
ldr x0, [x0, #24]
adr x1, x
str x0, [x1]
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("setting field", () => {
    const input = `
struct Person {
  var int age
}
var Person p
p.age = 20
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
p: .space 16
ldr x0, =20
mov x2, x0
adr x0, p
str x2, [x0, #8]
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("setting nested field", () => {
    const input = `
struct Address {
  var string line
}
struct Person {
  var int age
  var Address address
}
var Person p
p.address.line = "1 main st"
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
Address_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
.return_Address_init:
ldp x29, x30, [sp], #16
ret
Person_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
str x2, [x0, #16]
.return_Person_init:
ldp x29, x30, [sp], #16
ret
p: .space 24
adr x0, _str_0
mov x2, x0
adr x0, p
ldr x0, [x0, #16]
str x2, [x0, #8]

_str_0: .asciz "1 main st"
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("getting function", () => {
    const input = `
struct Person {
  func age = (out int) -> {
    return 20
  }
}
var Person p
var x = p.age()
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
Person_age:
stp x29, x30, [sp, #-16]!
mov x29, sp
ldr x0, =20
b .return_Person_age
.return_Person_age:
ldp x29, x30, [sp], #16
ret
p: .space 8
x: .space 8
bl Person_age
adr x1, x
str x0, [x1]
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("getting function after field", () => {
    const input = `
struct Address {
  func line = (out string) -> {
    return "123 main st"
  }
}
struct Person {
  var int age
  var Address address
}
var Person p
var x = p.address.line()
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
Address_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
.return_Address_init:
ldp x29, x30, [sp], #16
ret
Address_line:
stp x29, x30, [sp, #-16]!
mov x29, sp
adr x0, _str_0
b .return_Address_line
.return_Address_line:
ldp x29, x30, [sp], #16
ret
Person_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
str x2, [x0, #16]
.return_Person_init:
ldp x29, x30, [sp], #16
ret
p: .space 24
x: .space 8
bl Address_line
adr x1, x
str x0, [x1]

_str_0: .asciz "123 main st"
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("getting field after function", () => {
    const input = `
struct Address {
  var string line
}
struct Person {
  var int age
  func address = (out Address) -> {
    return Address("123 main st")
  }
}
var Person p
var x = p.address().line
`;
    const parsed = parse(input);
    const result = build(parsed.root, { arch: "aarch64" });
    const expected = `
Address_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
.return_Address_init:
ldp x29, x30, [sp], #16
ret
Person_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
.return_Person_init:
ldp x29, x30, [sp], #16
ret
Person_address:
stp x29, x30, [sp, #-16]!
mov x29, sp
_temp_0: .space 16
adr x0, _temp_0
adr x0, _str_0
mov x1, x0
bl Address_init
adr x0, _temp_0
b .return_Person_address
.return_Person_address:
ldp x29, x30, [sp], #16
ret
p: .space 16
x: .space 8
adr x0, p
ldr x0, [x0, #8]
adr x1, x
str x0, [x1]

_str_0: .asciz "123 main st"
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("access errors", () => {
  test("type mismatch getting field", () => {
    const input = `
struct Person {
  var string name
}
var Person p
var int x = p.name
`;
    const expected = [
      test_error(input, "Type mismatch in declaration: string (expected int)", 6, 13),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("type mismatch setting field", () => {
    const input = `
struct Person {
  var int age
}
var Person p
p.age = "hi"
`;
    const expected = [test_error(input, "Type mismatch in assignment: string (expected int)", 6, 9)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("unknown target", () => {
    const input = `
var age = person.age
`;
    const expected = [test_error(input, "Unknown value: person", 2, 11)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
