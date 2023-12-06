import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type ParseError from "../../src/types/ParseError";

const test = suite("Function errors");

test("unknown param type", () => {
  const input = `
func add(a: what) {}
`;
  const expected: ParseError[] = [
    {
      message: "Unknown type: what",
      i: 13,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("unknown param value type", () => {
  const input = `
func add(a = z0) {}
`;
  const expected: ParseError[] = [
    {
      message: "Unknown value type: z0",
      i: 14,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("param type mismatch", () => {
  const input = `
func add(a: int = "string?!") {}
`;
  const expected: ParseError[] = [
    {
      message: "Type mismatch: string cannot be assigned to int variable",
      i: 19,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("param type mismatch - unknown value type", () => {
  const input = `
func add(a: int = z0) {}
`;
  const expected: ParseError[] = [
    {
      message: "Type mismatch -- unknown value type: z0",
      i: 19,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("no param type or default value", () => {
  const input = `
func add(a) {}
`;
  const expected: ParseError[] = [
    {
      message: "Expected type or default value",
      i: 10,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("unknown return value type", () => {
  const input = `
func add() -> what {
  return 5
}
`;
  const expected: ParseError[] = [
    {
      message: "Unknown type: what",
      i: 15,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("return type mismatch", () => {
  const input = `
func add() -> int {
  return "string?!"
}
`;
  const expected: ParseError[] = [
    {
      message: "Type mismatch: string cannot be assigned to int variable",
      i: 30,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("return type mismatch - unknown value type", () => {
  const input = `
func add() -> int {
  return z0
}
`;
  const expected: ParseError[] = [
    {
      message: "Type mismatch -- unknown value type: z0",
      i: 30,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("missing return", () => {
  const input = `
func add() -> int {}
`;
  const expected: ParseError[] = [
    {
      message: "Missing return",
      i: 20,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test.run();
