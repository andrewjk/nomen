import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Access build");

test("getting field", () => {
  const input = `
struct Person {
  var age: int
}
var p: Person
var x = p.age
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[2]);
  const expected = `
int x = p.age;
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("getting nested field", () => {
  const input = `
struct Address {
  var line: string
}
struct Person {
  var age: int
  var address: Address
}
var p: Person
var x = p.address.line
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[3]);
  const expected = `
char* x = p.address.line;
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("setting field", () => {
  const input = `
struct Person {
  var age: int
}
var p: Person
p.age = 20
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[2]);
  const expected = `
p.age = 20;
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("setting nested field", () => {
  const input = `
struct Address {
  var line: string
}
struct Person {
  var age: int
  var address: Address
}
var p: Person
p.address.line = "1 main st"
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[3]);
  const expected = `
p.address.line = "1 main st";
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("getting function", () => {
  const input = `
struct Person {
  func age() -> int {
    return 20
  }
}
var p: Person
var x = p.age()
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[2]);
  const expected = `
int x = Person_age(&p);
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("getting function after field", () => {
  const input = `
struct Address {
  func line() -> string {
    return "123 main st"
  }
}
struct Person {
  var age: int
  var address: Address
}
var p: Person
var x = p.address.line()
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[3]);
  const expected = `
char* x = Address_line(&p.address);
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("getting field after function", () => {
  const input = `
struct Address {
  var line: string
}
struct Person {
  var age: int
  func address() -> Address {
    return Address.init("123 main st")
  }
}
var p: Person
var x = p.address().line
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[3]);
  const expected = `
char* x = Person_address(&p).line;
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
