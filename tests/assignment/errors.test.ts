import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type ParseError from "../../src/types/ParseError";

const test = suite("Assignment errors");

test("type mismatch", () => {
  const input = `
var x: int
x = "string?!"
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

test("type mismatch -- unknown value type", () => {
  const input = `
var x: int
x = z0
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

test("unknown variable", () => {
  const input = `
var x: int
y = "string?!"
`;
  const expected: ParseError[] = [
    {
      message: "Unknown variable: y",
      i: 12,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

// TODO: This should be fine, as long as it's done once only?
test("assignment to const", () => {
  const input = `
const x: int
x = 5
`;
  const expected: ParseError[] = [
    {
      message: "Assignment to const: x",
      i: 14,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test.run();
