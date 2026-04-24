import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("declaration build", () => {
  test("const with value", () => {
    const input = `
const x = 5
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 5;
`;
    expect(parsed.errors).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
  
  test("const with type", () => {
    const input = `
const int x
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x;
`;
    expect(parsed.errors).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
  
  test("var with value", () => {
    const input = `
var x = 5
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 5;
`;
    expect(parsed.errors).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
  
  test("var with type", () => {
    const input = `
var int x
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x;
`;
    expect(parsed.errors).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("const with type and value", () => {
    const input = `
const int x = 5
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x = 5;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("const with array type", () => {
    const input = `
const int[] x
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x[];
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("const with array type and value", () => {
    const input = `
const int[] x = [1, 2, 3]
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
long x[3] = {1, 2, 3};
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("declaration errors", () => {
  test("unknown type", () => {
    const input = `
const what x
`;
    const expected = [test_error(input, "Unknown type: what", 2, 7)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
  
  test("unknown value", () => {
    const input = `
const x = z0
`;
    const expected = [test_error(input, "Unknown value: z0", 2, 11)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
  
  test("type mismatch", () => {
    const input = `
const int x = "string?!"
`;
    const expected = [
      test_error(input, "Type mismatch in declaration: string (expected int)", 2, 15),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
  
  test("type mismatch - unknown value", () => {
    const input = `
const int x = z0
`;
    const expected = [test_error(input, "Unknown value: z0", 2, 15)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
  
  test("no type or default value", () => {
    const input = `
const x
`;
    const expected = [test_error(input, "Expected type or default value", 2, 7)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("unknown type with value", () => {
    const input = `
const what x = 5
`;
    const expected = [
      test_error(input, "Unknown type: what", 2, 7),
      test_error(input, "Type mismatch in declaration: int (expected what)", 2, 16),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
})
