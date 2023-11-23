import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Trait errors");

test("invalid syntax", () => {
  const input = `
trait Person People {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 14);
  assert.equal(result.errors[0].message, "Expected {");
});

test("child trait", () => {
  const input = `
trait Person {
  trait People {}
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 18);
  assert.equal(result.errors[0].message, "Trait cannot appear here");
});

test("child assignment", () => {
  const input = `
trait Person {
  var x: int
  x = 5
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 31);
  assert.equal(result.errors[0].message, "Assignment cannot appear here");
});

// TODO: non-existent traits, non-matching traits etc

test.run();
