import { expect, test } from "vitest";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";
import trim_test_parse from "../trim_test_parse";

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

test("accessing private fields", () => {
  const input = `
struct Person {
  private var name: string
  private func greet() {}
}
const x: Person
x.name = "Andrew"
x.greet()
`;
  const expected: CompileError[] = [
    {
      message: "Can't access private field: name",
      start: 90,
    },
    {
      message: "Can't access private function: greet",
      start: 108,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("private fields in trait", () => {
  const input = `
trait Person {
  private var name: string
  private func greet()
}
`;
  const expected: CompileError[] = [
    {
      message: "Trait fields cannot be private",
      start: 18,
    },
    {
      message: "Trait functions cannot be private",
      start: 45,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
