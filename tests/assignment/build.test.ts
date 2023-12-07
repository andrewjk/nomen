import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Assignment build");

test("assignment to var", () => {
  const input = `
var x: int
x = 5
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const result = build(parsed.root.children[1]);
  const expected = `
x = 5;
`;
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
