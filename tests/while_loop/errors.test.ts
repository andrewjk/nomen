import { expect, test } from "vitest";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

//const test = suite("While loop errors");

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
  expect(parsed.errors).toEqual(expected);
});
