import { expect, test } from "vitest";
import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Assignment errors");

test("type mismatch", () => {
  const input = `
var x: int
x = "string?!"
`;
  const expected = [test_error(input, "Type mismatch in assignment: string (expected int)", 3, 5)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("type mismatch -- unknown value", () => {
  const input = `
var x: int
x = z0
`;
  const expected = [
    test_error(input, "Type mismatch in assignment: unknown value z0 (expected int)", 3, 5),
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("unknown variable", () => {
  const input = `
var x: int
y = "string?!"
`;
  const expected = [test_error(input, "Unknown variable: y", 3, 1)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("assignment to const", () => {
  const input = `
const x  =5
x = 10
`;
  const expected = [test_error(input, "Assignment to const: x", 3, 1)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("double assignment to const", () => {
  const input = `
const x: int
x = 5
x = 10
`;
  const expected = [test_error(input, "Assignment to const: x", 4, 1)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("incomplete conditional assignment to const", () => {
  const input = `
const x: int
if true {
  x = 5
}
const y = x
`;
  const expected = [test_error(input, "Const set incompletely: x", 3, 1)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("assignment to const param", () => {
  const input = `
func set(x: int) {
  x = 5
}
`;
  const expected = [test_error(input, "Assignment to const: x", 3, 3)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
