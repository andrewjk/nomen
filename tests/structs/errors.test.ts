import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

const test = suite("Struct errors");

test("invalid syntax", () => {
  const input = `
struct Person People {}
`;
  const expected: CompileError[] = [
    {
      message: "Expected {",
      start: 15,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("child struct", () => {
  const input = `
struct Person {
  struct People {}
}
`;
  const expected: CompileError[] = [
    {
      message: "Struct cannot appear here",
      start: 19,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("child assignment", () => {
  const input = `
struct Person {
  var x: int
  x = 5
}
`;
  const expected: CompileError[] = [
    {
      message: "Assignment cannot appear here",
      start: 32,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test.run();
