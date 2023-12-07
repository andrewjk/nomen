import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";

const test = suite("Array build");

test("declaration with type", () => {
  const input = `
const x: int[]
`;
  const parsed = parse(input);
  const result = build(parsed.root.children[0]);
  const expected = `
int x[];
`;
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test("declaration with value", () => {
  const input = `
var x = [1, 2, 3]
`;
  const parsed = parse(input);
  const result = build(parsed.root.children[0]);
  const expected = `
int x[3] = {1, 2, 3};
`;
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
