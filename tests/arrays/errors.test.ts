import { suite } from "uvu";
import assert from "uvu/assert";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
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
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
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
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
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
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
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
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
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
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
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
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test.run();
