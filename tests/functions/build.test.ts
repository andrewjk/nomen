import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Function build");

test("function", () => {
  const input = `
func add() {}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
void add()
{
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("function with params", () => {
  const input = `
func add(a: int, b: int) {}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
void add(int a, int b)
{
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("function with params with default value", () => {
  const input = `
func add(a: int, b = 5) {}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
void add(int a, int b)
{
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("function with return type", () => {
  const input = `
func add() -> int {
  return 5
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
void add()
{
return 5;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("function with body", () => {
  const input = `
func add() {
  var x = 5
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
void add()
{
int x = 5;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("function with return value", () => {
  const input = `
func add() -> int {
  return 5
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
void add()
{
return 5;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

/*
test("function followed by function", () => {
  const input = `
func add() {}

func subtract() {}
`;
const parsed = parse(input);  const result = build(parsed.root.statements[0]);
  const expected = `
void add() {

}

void subtract() {

}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
*/
