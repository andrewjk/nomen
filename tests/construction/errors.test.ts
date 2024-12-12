import { expect, test } from "vitest";
import parse from "../../src/parse";
import test_error from "../test_error";

//const test = suite("Construction errors");

test("struct not found", () => {
  const input = `
const dog = Dog.init()
`;
  const expected = [test_error(input, "Unknown value: Dog", 2, 13)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("too many parameters", () => {
  const input = `
struct Dog {}
const dog = Dog.init("Spot")
`;
  const expected = [test_error(input, "Too many parameters for function: init", 3, 17)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("parameters missing", () => {
  const input = `
struct Dog {
    var name: string
}
const dog = Dog.init()
`;
  const expected = [test_error(input, "Parameters missing for function: init", 5, 17)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("param type mismatch", () => {
  const input = `
struct Dog {
    var name: string
}
const dog = Dog.init(5)
`;
  const expected = [test_error(input, "Type mismatch in param: int (expected string)", 5, 22)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});

test("param type mismatch -- unknown value", () => {
  const input = `
struct Dog {
    var name: string
}
const dog = Dog.init(z0)
`;
  const expected = [test_error(input, "Unknown value: z0", 5, 22)];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
