import { expect, test } from "vitest";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

//const test = suite("Access errors");

test("type mismatch getting field", () => {
  const input = `
struct Person {
  var name: string
}
var p: Person
var x: int = p.name
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in declaration: string (expected int)",
      start: 65,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("type mismatch setting field", () => {
  const input = `
struct Person {
  var age: int
}
var p: Person
p.age = "hi"
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in assignment: string (expected int)",
      start: 56,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("unknown target", () => {
  const input = `
var age = person.age
`;
  const expected: CompileError[] = [
    {
      message: "Unknown target: person",
      start: 11,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
