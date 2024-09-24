import { expect, test } from "vitest";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

//const test = suite("Invocation errors");

test("function not found", () => {
  const input = `
greet()
`;
  const expected: CompileError[] = [
    {
      message: "Function not found: greet",
      start: 1,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("too many parameters", () => {
  const input = `
func greet(first: int, second: int) {}
greet(1, 2, 3)
`;
  const expected: CompileError[] = [
    {
      message: "Too many parameters for function: greet",
      start: 40,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("parameters missing", () => {
  const input = `
func greet(first: int, second: int) {}
greet(1)
`;
  const expected: CompileError[] = [
    {
      message: "Parameters missing for function: greet",
      start: 40,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("param type mismatch", () => {
  const input = `
func greet(age: int) {}
greet("andrew")
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in param: string (expected int)",
      start: 31,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("param type mismatch -- unknown value", () => {
  const input = `
func greet(age: int) {}
greet(z0)
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in param: unknown value z0 (expected int)",
      start: 31,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
