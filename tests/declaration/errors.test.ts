import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

const test = suite("Declaration errors");

test("unknown type", () => {
  const input = `
const x: what
`;
  const expected: CompileError[] = [
    {
      message: "Unknown type: what",
      start: 10,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("unknown value", () => {
  const input = `
const x = z0
`;
  const expected: CompileError[] = [
    {
      message: "Unknown value: z0",
      start: 11,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("type mismatch", () => {
  const input = `
const x: int = "string?!"
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in declaration: string (expected int)",
      start: 16,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("type mismatch - unknown value", () => {
  const input = `
const x: int = z0
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in declaration: unknown value z0 (expected int)",
      start: 16,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("no type or default value", () => {
  const input = `
const x
`;
  const expected: CompileError[] = [
    {
      message: "Expected type or default value",
      start: 7,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test.run();
