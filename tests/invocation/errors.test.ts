import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type ParseError from "../../src/types/ParseError";

const test = suite("Invocation errors");

test("function not found", () => {
  const input = `
greet()
`;
  const expected: ParseError[] = [
    {
      message: "Function not found: greet",
      i: 1,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("too many parameters", () => {
  const input = `
func greet(first: int, second: int) {}
greet(1, 2, 3)
`;
  const expected: ParseError[] = [
    {
      message: "Too many parameters for function: greet",
      i: 40,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("parameters missing", () => {
  const input = `
func greet(first: int, second: int) {}
greet(1)
`;
  const expected: ParseError[] = [
    {
      message: "Parameters missing for function: greet",
      i: 40,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("param type mismatch", () => {
  const input = `
func greet(age: int) {}
greet("andrew")
`;
  const expected: ParseError[] = [
    {
      message: "Type mismatch: string cannot be used for int parameter",
      i: 31,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("param type mismatch -- unknown value type", () => {
  const input = `
func greet(age: int) {}
greet(z0)
`;
  const expected: ParseError[] = [
    {
      message:
        "Type mismatch -- unknown value type: z0 cannot be used for int parameter",
      i: 31,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test.run();
