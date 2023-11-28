import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Invocation build");

test("function without params", () => {
  const input = `
func greet() {}
greet()
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[1]);
  const expected = `
  greet();
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("function with params", () => {
  const input = `
func greet(name: string, position: string) {}
greet("Andrew", "Manager")
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[1]);
  const expected = `
  greet("Andrew", "Manager");
`;
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
