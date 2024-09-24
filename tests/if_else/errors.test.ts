import { expect, test } from "vitest";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

//const test = suite("If/else errors");

test("string condition", () => {
  const input = `
if "hi" {
  // ...
}
`;
  const expected: CompileError[] = [
    {
      message: "If/else condition must be a bool, not string",
      start: 4,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
