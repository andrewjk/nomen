import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Function errors");

test("unknown param type", () => {
  const input = `
func add(a: what) {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 13);
  assert.equal(result.errors[0].message, "Unknown type: what");
});

test("unknown param value type", () => {
  const input = `
func add(a = z0) {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 14);
  assert.equal(result.errors[0].message, "Unknown value type: z0");
});

test("param type mismatch", () => {
  const input = `
func add(a: int = "string?!") {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 19);
  assert.equal(
    result.errors[0].message,
    "Type mismatch: string cannot be assigned to int variable",
  );
});

test("param type mismatch - unknown value type", () => {
  const input = `
func add(a: int = z0) {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 19);
  assert.equal(
    result.errors[0].message,
    "Type mismatch -- unknown value type: z0",
  );
});

test("unknown return value type", () => {
  const input = `
func add() -> what {
  return 5
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 15);
  assert.equal(result.errors[0].message, "Unknown type: what");
});

test("return type mismatch", () => {
  const input = `
func add() -> int {
  return "string?!"
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 30);
  assert.equal(
    result.errors[0].message,
    "Type mismatch: string cannot be assigned to int variable",
  );
});

test("return type mismatch - unknown value type", () => {
  const input = `
func add() -> int {
  return z0
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 30);
  assert.equal(
    result.errors[0].message,
    "Type mismatch -- unknown value type: z0",
  );
});

test("missing return", () => {
  const input = `
func add() -> int {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 20);
  assert.equal(result.errors[0].message, "Missing return");
});
test.run();
