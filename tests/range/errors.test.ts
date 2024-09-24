import { expect, test } from "vitest";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

//const test = suite("Range errors");

test("type mismatch", () => {
  const input = `
var x = 1.."b"
`;
  const expected: CompileError[] = [
    {
      message: "Type mismatch in range: string (expected int)",
      start: 12,
    },
  ];
  const parsed = parse(input);
  expect(parsed.errors).toEqual(expected);
});
