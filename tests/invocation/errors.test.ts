import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Invocation errors");

test("function not found", () => {
  const input = `
greet()
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 1);
  assert.equal(result.errors[0].message, "Function not found: greet");
});

test("too many parameters", () => {
  const input = `
func greet(first: int, second: int) {}
greet(1, 2, 3)
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 40);
  assert.equal(
    result.errors[0].message,
    "Too many parameters for function: greet",
  );
});

test("parameters missing", () => {
  const input = `
func greet(first: int, second: int) {}
greet(1)
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 40);
  assert.equal(
    result.errors[0].message,
    "Parameters missing for function: greet",
  );
});

test("param type mismatch", () => {
  const input = `
func greet(age: int) {}
greet("andrew")
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  console.log(result.errors);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 31);
  assert.equal(
    result.errors[0].message,
    "Type mismatch: string cannot be used for int parameter",
  );
});

test("param type mismatch -- unknown value type", () => {
  const input = `
func greet(age: int) {}
greet(z0)
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].i, 31);
  assert.equal(
    result.errors[0].message,
    "Type mismatch -- unknown value type: z0 cannot be used for int parameter",
  );
});

test.run();
