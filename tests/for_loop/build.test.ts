import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("For loop build");

test("with array", () => {
  const input = `
const y = [1, 2, 3]
for x in y {}
`;
  const parsed = parse(input);
  const result = build(parsed.root);
  const expected = `
int y[3] = {1, 2, 3};
int x;
for (x = 0; x < 3; x++)
{
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("with range", () => {
  const input = `
for x in 0..5 {}
`;
  const parsed = parse(input);
  const result = build(parsed.root);
  const expected = `
int x;
for (x = 0; x < 5; x++)
{
}
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
int x = 1 + 2 - 3;
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
