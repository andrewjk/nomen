import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("assignment build", () => {
  test("assignment to var", () => {
    const input = `
var int x
x = 5
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x;
x = 5;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("single assignment to const", () => {
    const input = `
const int x
x = 5
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x;
x = 5;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("conditional assignment to const", () => {
    const input = `
const int x
if true {
  x = 5
} else {
  x = 10
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x;
if (true) {
x = 5;
} else {
x = 10;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("assignment to var param", () => {
    const input = `
func add = (var int x) -> {
  x = 5
}
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
void add(long *x)
{
x = 5;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("assignment with operation", () => {
    const input = `
var int x = 10
x = x + 5
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 10;
x = x + 5;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("assignment errors", () => {
  test("type mismatch", () => {
    const input = `
var int x
x = "string?!"
`;
    const expected = [test_error(input, "Type mismatch in assignment: string (expected int)", 3, 5)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("type mismatch -- unknown value", () => {
    const input = `
var int x
x = z0
`;
    const expected = [test_error(input, "Unknown value: z0", 3, 5)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("unknown variable", () => {
    const input = `
var int x
y = "string?!"
`;
    const expected = [test_error(input, "Unknown value: y", 3, 1)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("assignment to const", () => {
    const input = `
const x = 5
x = 10
`;
    const expected = [test_error(input, "Assignment to const: x", 3, 1)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("double assignment to const", () => {
    const input = `
const int x
x = 5
x = 10
`;
    const expected = [test_error(input, "Assignment to const: x", 4, 1)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("incomplete conditional assignment to const", () => {
    const input = `
const int x
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
func set = (int x) -> {
  x = 5
}
`;
    const expected = [test_error(input, "Assignment to const: x", 3, 3)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
