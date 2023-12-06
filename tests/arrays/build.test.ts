import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Array build");

test("declaration with type", () => {
  const input = `
const x: int[]
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
int x[];
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("declaration with value", () => {
  const input = `
var x = [1, 2, 3]
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
int x[3] = {1, 2, 3};
`;
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
