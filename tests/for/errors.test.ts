import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type CompileError from "../../src/types/CompileError";

const test = suite("For errors");

test("string list", () => {
  const input = `
for x in "hi" {
  // ...
}
`;
  const expected: CompileError[] = [
    {
      message: "For loop list must be an array, not string",
      start: 10,
    },
  ];
  const parsed = parse(input);
  assert.equal(parsed.errors, expected);
});

test.run();
