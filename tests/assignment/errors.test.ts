import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

const test = suite("Assignment errors");

test("type mismatch", () => {
  const input = `
var x: int
x = "string?!"
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in assignment: string (expected int)",
      start: 16,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("type mismatch -- unknown value", () => {
  const input = `
var x: int
x = z0
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in assignment: unknown value z0 (expected int)",
      start: 16,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("unknown variable", () => {
  const input = `
var x: int
y = "string?!"
`;
  const expected: CompileError[] = [
    {
      message: "Unknown variable: y",
      start: 12,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

// TODO: This should be fine, as long as it's done once only?
test("assignment to const", () => {
  const input = `
const x: int
x = 5
`;
  const expected: CompileError[] = [
    {
      message: "Assignment to const: x",
      start: 14,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test.run();
