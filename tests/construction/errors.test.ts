import { expect, test } from "vitest";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

//const test = suite("Construction errors");

test("struct not found", () => {
  const input = `
const dog = Dog.init()
`;
  const expected: CompileError[] = [
    {
      message: "Unknown target: Dog",
      start: 13,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
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
  const expected: CompileError[] = [
    {
      message: "Parameters missing for function: init",
      start: 53,
    },
  ];
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
  const expected: CompileError[] = [
    {
      message: "Type mismatch in param: int (expected string)",
      start: 58,
    },
  ];
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
  const expected: CompileError[] = [
    {
      message: "Type mismatch in param: unknown value z0 (expected string)",
      start: 58,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
