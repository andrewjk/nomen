import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";

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
  expect(result.code.trim()).toEqual(expected.trim());
});

test("single assignment to const", () => {
  const input = `
const x: int
x = 5
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x;
x = 5;
`;
  expect(parsed.errors).toEqual([]);
  expect(result.code.trim()).toEqual(expected.trim());
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
  expect(result.code.trim()).toEqual(expected.trim());
});
