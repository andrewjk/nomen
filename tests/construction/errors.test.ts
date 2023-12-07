import { suite } from "uvu";
import assert from "uvu/assert";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type CompileError from "../../src/types/CompileError";

const test = suite("Construction errors");

test("struct not found", () => {
  const input = `
const dog = Dog.init()
`;
  const expected: CompileError[] = [
    {
      // TODO: Better error here
      message: "Function not found: init",
      start: 17,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("too many parameters", () => {
  const input = `
struct Dog {}
const dog = Dog.init("Spot")
`;
  const expected: CompileError[] = [
    {
      message: "Too many parameters for function: init",
      start: 31,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("parameters missing", () => {
  const input = `
struct Dog {
    var name: string
}
const dog = Dog.init()
`;
  const expected: CompileError[] = [
    {
      message: "Parameters missing for function: init",
      start: 53,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("param type mismatch", () => {
  const input = `
struct Dog {
    var name: string
}
const dog = Dog.init(5)
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch: int cannot be used for string parameter",
      start: 58,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("param type mismatch -- unknown value type", () => {
  const input = `
struct Dog {
    var name: string
}
const dog = Dog.init(z0)
`;
  const expected: CompileError[] = [
    {
      message:
        "Type mismatch -- unknown value type: z0 cannot be used for string parameter",
      start: 58,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test.run();
