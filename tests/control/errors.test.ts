import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

const test = suite("Control errors");

test("break outside loop", () => {
  const input = `
func add() -> int {
  break
  return 5
}
`;
  const expected: CompileError[] = [
    {
      message: "Break must be inside a for or while loop",
      start: 23,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("continue outside loop", () => {
  const input = `
func add() -> int {
  continue
  return 5
}
`;
  const expected: CompileError[] = [
    {
      message: "Continue must be inside a for or while loop",
      start: 23,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("panic without a message", () => {
  const input = `
func add() -> int {
  panic
}
`;
  const expected: CompileError[] = [
    {
      message: "Expected a panic message",
      start: 29,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test("todo without a message", () => {
  const input = `
func add() -> int {
  todo
}
`;
  const expected: CompileError[] = [
    {
      message: "Expected a todo message",
      start: 28,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test.run();
