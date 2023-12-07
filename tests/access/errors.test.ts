import { suite } from "uvu";
import assert from "uvu/assert";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type CompileError from "../../src/types/CompileError";

const test = suite("Access errors");

test("type mismatch getting field", () => {
  const input = `
struct Person {
  var name: string
}
var p: Person
var x: int = p.name
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch: string cannot be assigned to int variable",
      start: 65,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("type mismatch setting field", () => {
  const input = `
struct Person {
  var age: int
}
var p: Person
p.age = "hi"
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch: string cannot be assigned to int variable",
      start: 56,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test.run();
