import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type ParseError from "../../src/types/ParseError";

const test = suite("Declaration errors");

test("unknown type", () => {
  const input = `
const x: what
`;
  const expected: ParseError[] = [
    {
      message: "Unknown type: what",
      i: 10,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("unknown value type", () => {
  const input = `
const x = z0
`;
  const expected: ParseError[] = [
    {
      message: "Unknown value type: z0",
      i: 11,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("type mismatch", () => {
  const input = `
const x: int = "string?!"
`;
  const expected: ParseError[] = [
    {
      message: "Type mismatch: string cannot be assigned to int variable",
      i: 16,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("type mismatch - unknown value type", () => {
  const input = `
const x: int = z0
`;
  const expected: ParseError[] = [
    {
      message: "Type mismatch -- unknown value type: z0",
      i: 16,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("no type or default value", () => {
  const input = `
const x
`;
  const expected: ParseError[] = [
    {
      message: "Expected type or default value",
      i: 7,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test.run();
