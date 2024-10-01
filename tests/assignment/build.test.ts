import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Assignment build");

test("assignment to var", () => {
  const input = `
var x: int
x = 5
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[1]);
  const expected = `
x = 5;
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("single assignment to const", () => {
  const input = `
const x: int
x = 5
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[1]);
  const expected = `
x = 5;
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("conditional assignment to const", () => {
  const input = `
const x: int
if true {
  x = 5
} else {
  x = 10
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[1]);
  const expected = `
if (true) {
x = 5;
} else {
x = 10;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("assignment to var param", () => {
  const input = `
func (var x: int) {
  x = 5
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
void add(int *x)
{
(*x) = 5;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
