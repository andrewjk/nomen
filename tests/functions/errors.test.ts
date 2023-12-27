import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

const test = suite("Function errors");

test("unknown param type", () => {
  const input = `
func add(a: what) {}
`;
  const expected: CompileError[] = [
    {
      message: "Unknown type: what",
      start: 13,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("unknown param value type", () => {
  const input = `
func add(a = z0) {}
`;
  const expected: CompileError[] = [
    {
      message: "Unknown value type: z0",
      start: 14,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("param type mismatch", () => {
  const input = `
func add(a: int = "string?!") {}
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in param default: string (expected int)",
      start: 19,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("param type mismatch - unknown value type", () => {
  const input = `
func add(a: int = z0) {}
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in param default: unknown value type z0 (expected int)",
      start: 19,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("no param type or default value", () => {
  const input = `
func add(a) {}
`;
  const expected: CompileError[] = [
    {
      message: "Expected type or default value",
      start: 10,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("unknown return value type", () => {
  const input = `
func add() -> what {
  return 5
}
`;
  const expected: CompileError[] = [
    {
      message: "Unknown type: what",
      start: 15,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("return type mismatch", () => {
  const input = `
func add() -> int {
  return "string?!"
}
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in return: string (expected int)",
      start: 30,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("return type mismatch - unknown value type", () => {
  const input = `
func add() -> int {
  return z0
}
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in return: unknown value type z0 (expected int)",
      start: 30,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("missing return", () => {
  const input = `
func add() -> int {}
`;
  const expected: CompileError[] = [
    {
      message: "Missing return",
      start: 20,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test.run();
