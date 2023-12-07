import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";

const test = suite("Construction build");

test("init struct", () => {
  const input = `
struct Person {
}
var x = Person.init()
`;
  const parsed = parse(input);
  const result = build(parsed.root.children[1]);
  const expected = `
Person x = Person_init();
`;
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test("init struct with params", () => {
  const input = `
struct Person {
  var name: string
}
var x = Person.init("Andrew")
`;
  const parsed = parse(input);
  const result = build(parsed.root.children[1]);
  const expected = `
Person x = Person_init("Andrew");
`;
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
