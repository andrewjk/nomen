import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";

const test = suite("Invocation build");

test("function without params", () => {
  const input = `
func greet() {}
greet()
`;
  const parsed = parse(input);
  const result = build(parsed.root.children[1]);
  const expected = `
greet();
`;
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test("function with params", () => {
  const input = `
func greet(name: string, position: string) {}
greet("Andrew", "Manager")
`;
  const parsed = parse(input);
  const result = build(parsed.root.children[1]);
  const expected = `
greet("Andrew", "Manager");
`;
  assert.equal(parsed.errors, []);
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
