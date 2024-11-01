import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Operation build");

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
