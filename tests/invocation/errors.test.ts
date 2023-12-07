import { suite } from "uvu";
import assert from "uvu/assert";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type CompileError from "../../src/types/CompileError";

const test = suite("Invocation errors");

test("function not found", () => {
  const input = `
greet()
`;
  const expected: CompileError[] = [
    {
      message: "Function not found: greet",
      start: 1,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("too many parameters", () => {
  const input = `
func greet(first: int, second: int) {}
greet(1, 2, 3)
`;
  const expected: CompileError[] = [
    {
      message: "Too many parameters for function: greet",
      start: 40,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("parameters missing", () => {
  const input = `
func greet(first: int, second: int) {}
greet(1)
`;
  const expected: CompileError[] = [
    {
      message: "Parameters missing for function: greet",
      start: 40,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("param type mismatch", () => {
  const input = `
func greet(age: int) {}
greet("andrew")
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch: string cannot be used for int parameter",
      start: 31,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("param type mismatch -- unknown value type", () => {
  const input = `
func greet(age: int) {}
greet(z0)
`;
  const expected: CompileError[] = [
    {
      message:
        "Type mismatch -- unknown value type: z0 cannot be used for int parameter",
      start: 31,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test.run();
