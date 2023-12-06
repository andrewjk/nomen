import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("For build");

test("with array", () => {
  const input = `
const y = [1, 2, 3]
for x in y {}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[1]);
  const expected = `
int x;
for (x = 0; x < 3; x++)
{
}
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("with range", () => {
  const input = `
for x in 0..5 {}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
int x;
for (x = 0; x < 5; x++)
{
}
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
