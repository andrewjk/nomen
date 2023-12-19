import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";

const test = suite("While loop build");

test("while", () => {
  const input = `
var x = 0
while x < 5 {
  x = x + 1
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[1]);
  const expected = `
while (x < 5) {
x = x + 1;
}
`;
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test("while true", () => {
  const input = `
while true {
  // ...
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
while (true) {
}
`;
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
