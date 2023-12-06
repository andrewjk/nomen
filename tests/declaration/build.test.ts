import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Declaration build");

test("const with value", () => {
  const input = `
const x = 5
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
int x = 5;
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("const with type", () => {
  const input = `
const x: int
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
int x;
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("var with value", () => {
  const input = `
var x = 5
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
int x = 5;
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("var with type", () => {
  const input = `
var x: int
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
int x;
`;
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
