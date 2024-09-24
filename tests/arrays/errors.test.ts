import { expect, test } from "vitest";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

//const test = suite("Array errors");

test("declaration type mismatch", () => {
  const input = `
const x: int[] = ["a", "b", "c"]
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in array: string (expected int)",
      start: 19,
    },
    {
      message: "Type mismatch in array: string (expected int)",
      start: 24,
    },
    {
      message: "Type mismatch in array: string (expected int)",
      start: 29,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("declaration type mixed", () => {
  const input = `
const x = [1, "b", 2]
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in array: string (expected int)",
      start: 15,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("declaration type not an array", () => {
  const input = `
const x: int[] = 5
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in declaration: int (expected int[])",
      start: 18,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("assignment type mismatch", () => {
  const input = `
var x: int[]
x = ["a", "b", "c"]
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in array: string (expected int)",
      start: 19,
    },
    {
      message: "Type mismatch in array: string (expected int)",
      start: 24,
    },
    {
      message: "Type mismatch in array: string (expected int)",
      start: 29,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("assignment type mixed", () => {
  const input = `
var x: int[]
x = [1, "b", 2]
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in array: string (expected int)",
      start: 22,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("assignment type not an array", () => {
  const input = `
var x: int[]
x = 5
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in assignment: int (expected int[])",
      start: 18,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
