import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Access errors");

test("type mismatch getting field", () => {
  const input = `
struct Person {
  var name: string
}
var p: Person
var x: int = p.name
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 67);
  assert.equal(
    result.errors[0].message,
    "Type mismatch: string cannot be assigned to int variable",
  );
});

test("type mismatch setting field", () => {
  const input = `
struct Person {
  var age: int
}
var p: Person
p.age = "hi"
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 56);
  assert.equal(
    result.errors[0].message,
    "Type mismatch: string cannot be assigned to int variable",
  );
});

test.run();
