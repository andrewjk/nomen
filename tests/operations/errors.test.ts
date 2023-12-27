import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

const test = suite("Operation errors");

test("type mismatch", () => {
  const input = `
const x = 5 + "b"
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in operation: string (expected int)",
      start: 15,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("declaration type mismatch", () => {
  const input = `
const x: int = "a" + "b"
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in declaration: string (expected int)",
      start: 16,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("assignment type mismatch", () => {
  const input = `
var x: int
x = "a" + "b"
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in assignment: string (expected int)",
      start: 16,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test.run();
