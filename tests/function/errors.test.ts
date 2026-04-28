import { expect, test } from "vite-plus/test";

import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Function errors");

test("unknown param type", () => {
  const input = `
func add(a: what) {}
`;
  const expected = [test_error(input, "Unknown type: what", 2, 13)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("unknown param value type", () => {
  const input = `
func add(a = z0) {}
`;
  const expected = [test_error(input, "Unknown value: z0", 2, 14)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("param type mismatch", () => {
  const input = `
func add(a: int = "string?!") {}
`;
  const expected = [
    test_error(input, "Type mismatch in param default: string (expected int)", 2, 19),
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("param type mismatch - unknown value", () => {
  const input = `
func add(a: int = z0) {}
`;
  const expected = [test_error(input, "Unknown value: z0", 2, 19)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("no param type or default value", () => {
  const input = `
func add(a) {}
`;
  const expected = [test_error(input, "Expected type or default value", 2, 10)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("unknown return value type", () => {
  const input = `
func add() -> what {
  return 5
}
`;
  const expected = [test_error(input, "Unknown type: what", 2, 15)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("return type mismatch", () => {
  const input = `
func add() -> int {
  return "string?!"
}
`;
  const expected = [test_error(input, "Type mismatch in return: string (expected int)", 3, 10)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("return type mismatch - unknown value", () => {
  const input = `
func add() -> int {
  return z0
}
`;
  const expected = [test_error(input, "Unknown value: z0", 3, 10)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("missing return", () => {
  const input = `
func add() -> int {}
`;
  const expected = [test_error(input, "Missing return", 2, 20)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
