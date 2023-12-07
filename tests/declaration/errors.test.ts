import { suite } from "uvu";
import assert from "uvu/assert";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type CompileError from "../../src/types/CompileError";

const test = suite("Declaration errors");

test("unknown type", () => {
  const input = `
const x: what
`;
  const expected: CompileError[] = [
    {
      message: "Unknown type: what",
      start: 10,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("unknown value type", () => {
  const input = `
const x = z0
`;
  const expected: CompileError[] = [
    {
      message: "Unknown value type: z0",
      start: 11,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("type mismatch", () => {
  const input = `
const x: int = "string?!"
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

test("type mismatch - unknown value type", () => {
  const input = `
const x: int = z0
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch -- unknown value type: z0",
      start: 16,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("no type or default value", () => {
  const input = `
const x
`;
  const expected: CompileError[] = [
    {
      message: "Expected type or default value",
      start: 7,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test.run();
