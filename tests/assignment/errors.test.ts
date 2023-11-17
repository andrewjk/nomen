import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";

const test = suite("Assignment errors");

test("type mismatch", () => {
  const input = `
var x: int
x = "string?!"
`;
  const result = parse(input);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  // TODO: Shouldn't that be 15?
  assert.equal(result.errors[0].i, 15);
  assert.equal(
    result.errors[0].message,
    "Type mismatch: string cannot be assigned to int variable"
  );
});

test("type mismatch -- unknown value type", () => {
  const input = `
var x: int
x = z0
`;
  const result = parse(input);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 16);
  assert.equal(
    result.errors[0].message,
    "Type mismatch -- unknown value type: z0"
  );
});

test("unknown variable", () => {
  const input = `
var x: int
y = "string?!"
`;
  const result = parse(input);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 12);
  assert.equal(result.errors[0].message, "Unknown variable: y");
});

test("assignment to const", () => {
  const input = `
const x: int
x = 5
`;
  const result = parse(input);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 14);
  assert.equal(result.errors[0].message, "Assignment to const: x");
});

test.run();
