import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";

const test = suite("Declaration build");

test("const with value", () => {
  const input = `
const x = 5
`;
  const parsed = parse(input);
  const result = build(parsed.root.children[0]);
  const expected = `
int x = 5;
`;
  assert.equal(parsed.errors, []);
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test("const with type", () => {
  const input = `
const x: int
`;
  const parsed = parse(input);
  const result = build(parsed.root.children[0]);
  const expected = `
int x;
`;
  assert.equal(parsed.errors, []);
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test("var with value", () => {
  const input = `
var x = 5
`;
  const parsed = parse(input);
  const result = build(parsed.root.children[0]);
  const expected = `
int x = 5;
`;
  assert.equal(parsed.errors, []);
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test("var with type", () => {
  const input = `
var x: int
`;
  const parsed = parse(input);
  const result = build(parsed.root.children[0]);
  const expected = `
int x;
`;
  assert.equal(parsed.errors, []);
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
