import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

const test = suite("Array errors");

// TODO: Better error text

test("declaration type mismatch", () => {
  const input = `
const x: int[] = ["a", "b", "c"]
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch: string[] cannot be assigned to int[] variable",
      start: 18,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("declaration type mixed", () => {
  const input = `
const x = [1, "b", 2]
`;
  const expected: CompileError[] = [
    {
      message: "Invalid type in array: string (expected int)",
      start: 15,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("declaration type not an array", () => {
  const input = `
const x: int[] = 5
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch: int cannot be assigned to int[] variable",
      start: 18,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("assignment type mismatch", () => {
  const input = `
var x: int[]
x = ["a", "b", "c"]
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch: string[] cannot be assigned to int[] variable",
      start: 18,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("assignment type mixed", () => {
  const input = `
var x: int[]
x = [1, "b", 2]
`;
  const expected: CompileError[] = [
    {
      message: "Invalid type in array: string (expected int)",
      start: 22,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("assignment type not an array", () => {
  const input = `
var x: int[]
x = 5
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch: int cannot be assigned to int[] variable",
      start: 18,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test.run();
