import { expect, test } from "vite-plus/test";

import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Trait errors");

test("invalid syntax", () => {
  const input = `
trait Person People {}
`;
  const expected = [test_error(input, "Expected {", 2, 14)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("child trait", () => {
  const input = `
trait Person {
  trait People {}
}
`;
  const expected = [test_error(input, "Trait cannot appear here", 3, 3)];
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
  const expected = [test_error(input, "Assignment cannot appear here", 4, 3)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("unknown trait", () => {
  const input = `
struct Frank: Person {
}
`;
  // TODO: Better start location
  const expected = [test_error(input, "Unknown trait: Person", 2, 1)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

// TODO: non-matching traits etc
