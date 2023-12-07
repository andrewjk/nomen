import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";

const test = suite("Assignment build");

test("assignment to var", () => {
  const input = `
var x: int
x = 5
`;
  const parsed = parse(input);
  const result = build(parsed.root.children[1]);
  const expected = `
x = 5;
`;
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
