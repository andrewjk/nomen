import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("operation build", () => {
  test("addition", () => {
    const input = `
var x = 1 + 2
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 1 + 2;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("subtraction", () => {
    const input = `
var x = 1 - 2
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 1 - 2;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("series", () => {
    const input = `
var x = 1 + 2 - 3
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 1 + 2 - 3;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("multiplication", () => {
    const input = `
var x = 3 * 4
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 3 * 4;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("division", () => {
    const input = `
var x = 10 / 2
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 10 / 2;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("operator precedence", () => {
    const input = `
var x = 1 + 2 * 3
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 1 + 2 * 3;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("grouped precedence", () => {
    const input = `
var x = (1 + 2) * 3
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = (1 + 2) * 3;
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
    const expected = [test_error(input, "Type mismatch in operation: string (expected int)", 2, 15)];
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
    const expected = [test_error(input, "Type mismatch in assignment: string (expected int)", 3, 5)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
