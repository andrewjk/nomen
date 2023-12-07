import { suite } from "uvu";
import assert from "uvu/assert";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type CompileError from "../../src/types/CompileError";

const test = suite("Trait errors");

test("invalid syntax", () => {
  const input = `
trait Person People {}
`;
  const expected: CompileError[] = [
    {
      message: "Expected {",
      start: 14,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("child trait", () => {
  const input = `
trait Person {
  trait People {}
}
`;
  const expected: CompileError[] = [
    {
      message: "Trait cannot appear here",
      start: 18,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("child assignment", () => {
  const input = `
trait Person {
  var x: int
  x = 5
}
`;
  const expected: CompileError[] = [
    {
      message: "Assignment cannot appear here",
      start: 31,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

test("unknown trait", () => {
  const input = `
struct Frank: Person {
}
`;
  // TODO: Better start location
  const expected: CompileError[] = [
    {
      message: "Unknown trait: Person",
      start: 1,
    },
  ];
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  assert.equal(parsed.errors.concat(checked.errors), expected);
});

// TODO: non-matching traits etc

test.run();
