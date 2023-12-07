import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Operation build");

test("addition", () => {
  const input = `
var x = 1 + 2
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const result = build(parsed.root.children[0]);
  const expected = `
int x = 1 + 2;
`;
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(result.code.trim(), expected.trim());
});

test("subtraction", () => {
  const input = `
var x = 1 - 2
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const result = build(parsed.root.children[0]);
  const expected = `
int x = 1 - 2;
`;
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(result.code.trim(), expected.trim());
});

test("series", () => {
  const input = `
var x = 1 + 2 - 3
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const result = build(parsed.root.children[0]);
  const expected = `
int x = 1 + 2 - 3;
`;
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
