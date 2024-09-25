import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Array build");

test("declaration with type", () => {
  const input = `
const x: int[]
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x[];
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("declaration with value", () => {
  const input = `
var x = [1, 2, 3]
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x[3] = {1, 2, 3};
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
