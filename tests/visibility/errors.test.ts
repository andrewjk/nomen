import { expect, test } from "vite-plus/test";

import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Pub errors");

test("invalid target", () => {
  const input = `
pub if true {
  // ...
}
`;
  const expected = [
    test_error(input, "Visibility can only be set for const, var, struct, trait or func", 2, 1),
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
  const expected = [
    test_error(input, "Can't access private field: name", 7, 3),
    test_error(input, "Can't access private function: greet", 8, 3),
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
  const expected = [
    test_error(input, "Trait fields cannot be private", 3, 3),
    test_error(input, "Trait functions cannot be private", 4, 3),
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
