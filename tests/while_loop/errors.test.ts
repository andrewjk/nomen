import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

const test = suite("While loop errors");

test("string condition", () => {
  const input = `
while "hi" {
  // ...
}
`;
  const expected: CompileError[] = [
    {
      message: "While loop condition must be a bool, not string",
      start: 7,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test.run();
