import { suite } from "uvu";
import assert from "uvu/assert";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
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
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test.run();
