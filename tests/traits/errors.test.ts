import { expect, test } from "vitest";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

//const test = suite("Trait errors");

test("invalid syntax", () => {
  const input = `
trait Person People {}
`;
  const expected: CompileError[] = [
    {
      message: "Expected {",
      start: 14,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("child trait", () => {
  const input = `
trait Person {
  trait People {}
}
`;
  const expected: CompileError[] = [
    {
      message: "Trait cannot appear here",
      start: 18,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("child assignment", () => {
  const input = `
trait Person {
  var x: int
  x = 5
}
`;
  const expected: CompileError[] = [
    {
      message: "Assignment cannot appear here",
      start: 31,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("unknown trait", () => {
  const input = `
struct Frank: Person {
}
`;
  // TODO: Better start location
  const expected: CompileError[] = [
    {
      message: "Unknown trait: Person",
      start: 1,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

// TODO: non-matching traits etc
