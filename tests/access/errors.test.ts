import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type ParseError from "../../src/types/ParseError";

const test = suite("Access errors");

test("type mismatch getting field", () => {
  const input = `
struct Person {
  var name: string
}
var p: Person
var x: int = p.name
`;
  const expected: ParseError[] = [
    {
      message: "Type mismatch: string cannot be assigned to int variable",
      i: 67,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test("type mismatch setting field", () => {
  const input = `
struct Person {
  var age: int
}
var p: Person
p.age = "hi"
`;
  const expected: ParseError[] = [
    {
      message: "Type mismatch: string cannot be assigned to int variable",
      i: 56,
    },
  ];
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.errors, expected);
});

test.run();
