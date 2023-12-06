import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type ParseError from "../../src/types/ParseError";

const test = suite("Struct errors");

test("invalid syntax", () => {
  const input = `
struct Person People {}
`;
  const expected: ParseError[] = [
    {
      message: "Expected {",
      i: 15,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("child struct", () => {
  const input = `
struct Person {
  struct People {}
}
`;
  const expected: ParseError[] = [
    {
      message: "Struct cannot appear here",
      i: 19,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("child assignment", () => {
  const input = `
struct Person {
  var x: int
  x = 5
}
`;
  const expected: ParseError[] = [
    {
      message: "Assignment cannot appear here",
      i: 32,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test.run();
