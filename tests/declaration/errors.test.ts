import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";

const test = suite("Declaration errors");

test("unknown type", () => {
  const input = `
const x: what
`;
  const result = parse(input);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 10);
  assert.equal(result.errors[0].message, "Unknown type: what");
});

test("unknown value type", () => {
  const input = `
const x = z0
`;
  const result = parse(input);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 11);
  assert.equal(result.errors[0].message, "Unknown value type: z0");
});

test("type mismatch", () => {
  const input = `
const x: int = "string?!"
`;
  const result = parse(input);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  // TODO: Shouldn't that be 16?
  assert.equal(result.errors[0].i, 15);
  assert.equal(
    result.errors[0].message,
    "Type mismatch: string cannot be assigned to int variable"
  );
});

test("type mismatch - unknown value type", () => {
  const input = `
const x: int = z0
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

test.run();
