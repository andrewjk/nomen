import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";

//const test = suite("Range build");

test("exclusive", () => {
  const input = `
var x = 1..4
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x[] = {1, 2, 3};
`;
  expect(parsed.errors).toEqual([]);
  expect(result.code.trim()).toEqual(expected.trim());
});

test("inclusive", () => {
  const input = `
var x = 1.=4
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x[] = {1, 2, 3, 4};
`;
  expect(parsed.errors).toEqual([]);
  expect(result.code.trim()).toEqual(expected.trim());
});
