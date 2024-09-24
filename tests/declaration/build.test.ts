import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";

//const test = suite("Declaration build");

test("const with value", () => {
  const input = `
const x = 5
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x = 5;
`;
  expect(parsed.errors).toEqual([]);
  expect(parsed.errors).toEqual([]);
  expect(result.code.trim()).toEqual(expected.trim());
});

test("const with type", () => {
  const input = `
const x: int
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x;
`;
  expect(parsed.errors).toEqual([]);
  expect(parsed.errors).toEqual([]);
  expect(result.code.trim()).toEqual(expected.trim());
});

test("var with value", () => {
  const input = `
var x = 5
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x = 5;
`;
  expect(parsed.errors).toEqual([]);
  expect(parsed.errors).toEqual([]);
  expect(result.code.trim()).toEqual(expected.trim());
});

test("var with type", () => {
  const input = `
var x: int
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x;
`;
  expect(parsed.errors).toEqual([]);
  expect(parsed.errors).toEqual([]);
  expect(result.code.trim()).toEqual(expected.trim());
});
