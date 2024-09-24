import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";

//const test = suite("Operation build");

test("addition", () => {
  const input = `
var x = 1 + 2
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x = 1 + 2;
`;
  expect(parsed.errors).toEqual([]);
  expect(result.code.trim()).toEqual(expected.trim());
});

test("subtraction", () => {
  const input = `
var x = 1 - 2
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x = 1 - 2;
`;
  expect(parsed.errors).toEqual([]);
  expect(result.code.trim()).toEqual(expected.trim());
});

test("series", () => {
  const input = `
var x = 1 + 2 - 3
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x = 1 + 2 - 3;
`;
  expect(parsed.errors).toEqual([]);
  expect(result.code.trim()).toEqual(expected.trim());
});
