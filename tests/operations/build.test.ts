import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Operation build");

test("addition", () => {
  const input = `
var x = 1 + 2
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
int x = 1 + 2;
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("subtraction", () => {
  const input = `
var x = 1 - 2
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
int x = 1 - 2;
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("series", () => {
  const input = `
var x = 1 + 2 - 3
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
int x = 1 + 2 - 3;
`;
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
