import { expect, test } from "vitest";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

//const test = suite("Pub errors");

test("invalid target", () => {
  const input = `
pub if true {
  // ...
}
`;
  const expected: CompileError[] = [
    {
      message: "Visibility can only be set for const, var, struct, trait or func",
      start: 1,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("accessing sec fields", () => {
  const input = `
struct Person {
  sec var name: string
  sec func greet() {}
}
const x: Person
x.name = "Andrew"
x.greet()
`;
  const expected: CompileError[] = [
    {
      message: "Can't access secret field: name",
      start: 82,
    },
    {
      message: "Can't access secret function: greet",
      start: 100,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("sec fields in trait", () => {
  const input = `
trait Person {
  sec var name: string
  sec func greet()
}
`;
  const expected: CompileError[] = [
    {
      message: "Trait fields cannot be secret",
      start: 18,
    },
    {
      message: "Trait functions cannot be secret",
      start: 41,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
