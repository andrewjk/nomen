import { expect, test } from "vitest";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

//const test = suite("Assignment errors");

test("type mismatch", () => {
  const input = `
var x: int
x = "string?!"
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in assignment: string (expected int)",
      start: 16,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("type mismatch -- unknown value", () => {
  const input = `
var x: int
x = z0
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in assignment: unknown value z0 (expected int)",
      start: 16,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("unknown variable", () => {
  const input = `
var x: int
y = "string?!"
`;
  const expected: CompileError[] = [
    {
      message: "Unknown variable: y",
      start: 12,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("assignment to const", () => {
  const input = `
const x  =5
x = 10
`;
  const expected: CompileError[] = [
    {
      message: "Assignment to const: x",
      start: 13,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("double assignment to const", () => {
  const input = `
const x: int
x = 5
x = 10
`;
  const expected: CompileError[] = [
    {
      message: "Assignment to const: x",
      start: 20,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("incomplete conditional assignment to const", () => {
  const input = `
const x: int
if true {
  x = 5
}
const y = x
`;
  const expected: CompileError[] = [
    {
      message: "Const set incompletely: x",
      start: 14,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("assignment to const param", () => {
  const input = `
func set(x: int) {
  x = 5
}
`;
  const expected: CompileError[] = [
    {
      message: "Assignment to const: x",
      start: 22,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
