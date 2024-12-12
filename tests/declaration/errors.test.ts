import { expect, test } from "vitest";
import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Declaration errors");

test("unknown type", () => {
  const input = `
const x: what
`;
  const expected = [test_error(input, "Unknown type: what", 2, 10)];
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
const x: int = "string?!"
`;
  const expected = [
    test_error(input, "Type mismatch in declaration: string (expected int)", 2, 16),
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("type mismatch - unknown value", () => {
  const input = `
const x: int = z0
`;
  const expected = [test_error(input, "Unknown value: z0", 2, 16)];
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
