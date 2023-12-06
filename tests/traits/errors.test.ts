import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type ParseError from "../../src/types/ParseError";

const test = suite("Trait errors");

test("invalid syntax", () => {
  const input = `
trait Person People {}
`;
  const expected: ParseError[] = [
    {
      message: "Expected {",
      i: 14,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("child trait", () => {
  const input = `
trait Person {
  trait People {}
}
`;
  const expected: ParseError[] = [
    {
      message: "Trait cannot appear here",
      i: 18,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("child assignment", () => {
  const input = `
trait Person {
  var x: int
  x = 5
}
`;
  const expected: ParseError[] = [
    {
      message: "Assignment cannot appear here",
      i: 31,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

// TODO: non-existent traits, non-matching traits etc

test.run();
