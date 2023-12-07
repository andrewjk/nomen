import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

const test = suite("Range errors");

test("type mismatch", () => {
  const input = `
var x = 1.."b"
`;
  const expected: CompileError[] = [
    {
      message: "Invalid type in range: string (expected int)",
      start: 12,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test.run();
