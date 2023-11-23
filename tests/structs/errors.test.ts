import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Struct errors");

test("invalid syntax", () => {
  const input = `
struct Person People {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 15);
  assert.equal(result.errors[0].message, "Expected {");
});

test("child struct", () => {
  const input = `
struct Person {
  struct People {}
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 19);
  assert.equal(result.errors[0].message, "Struct cannot appear here");
});

test("child assignment", () => {
  const input = `
struct Person {
  var x: int
  x = 5
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 32);
  assert.equal(result.errors[0].message, "Assignment cannot appear here");
});

test.run();
