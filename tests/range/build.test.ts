import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";

const test = suite("Range build");

test("exclusive", () => {
  const input = `
var x = 1..4
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x[] = {1, 2, 3};
`;
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test("inclusive", () => {
  const input = `
var x = 1.=4
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
int x[] = {1, 2, 3, 4};
`;
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
