import { expect, test } from "vitest";
import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Function call errors");

test("function not found", () => {
  const input = `
greet()
`;
  const expected = [test_error(input, "Function not found: greet", 2, 1)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("too many parameters", () => {
  const input = `
func greet(first: int, second: int) {}
greet(1, 2, 3)
`;
  const expected = [test_error(input, "Too many parameters for function: greet", 3, 1)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("parameters missing", () => {
  const input = `
func greet(first: int, second: int) {}
greet(1)
`;
  const expected = [test_error(input, "Parameters missing for function: greet", 3, 1)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("param type mismatch", () => {
  const input = `
func greet(age: int) {}
greet("andrew")
`;
  const expected = [test_error(input, "Type mismatch in param: string (expected int)", 3, 7)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("param type mismatch -- unknown value", () => {
  const input = `
func greet(age: int) {}
greet(z0)
`;
  const expected = [test_error(input, "Unknown value: z0", 3, 7)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
