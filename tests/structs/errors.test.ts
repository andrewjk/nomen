import { expect, test } from "vitest";
import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Struct errors");

test("invalid syntax", () => {
  const input = `
struct Person People {}
`;
  const expected = [test_error(input, "Expected {", 2, 15)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("child struct", () => {
  const input = `
struct Person {
  struct People {}
}
`;
  const expected = [test_error(input, "Struct cannot appear here", 3, 3)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("child assignment", () => {
  const input = `
struct Person {
  var x: int
  x = 5
}
`;
  const expected = [test_error(input, "Assignment cannot appear here", 4, 3)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
