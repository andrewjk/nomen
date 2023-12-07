import { suite } from "uvu";
import assert from "uvu/assert";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type CompileError from "../../src/types/CompileError";

const test = suite("Operation errors");

test("type mismatch", () => {
  const input = `
const x = 5 + "b"
`;
  const expected: CompileError[] = [
    {
      message: "Invalid type in operation: string (expected int)",
      start: 15,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("declaration type mismatch", () => {
  const input = `
const x: int = "a" + "b"
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch: string cannot be assigned to int variable",
      start: 16,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("assignment type mismatch", () => {
  const input = `
var x: int
x = "a" + "b"
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch: string cannot be assigned to int variable",
      start: 16,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test.run();
