import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Access build");

test("getting field", () => {
  const input = `
struct Person {
  var age: int
}
var p: Person
var x = p.age
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[2]);
  const expected = `
  int x = p.age;
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("getting nested field", () => {
  const input = `
struct Address {
  var line: string
}
struct Person {
  var age: int
  var address: Address
}
var p: Person
var x = p.address.line
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[3]);
  const expected = `
  char* x = p.address.line;
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("setting field", () => {
  const input = `
struct Person {
  var age: int
}
var p: Person
p.age = 20
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[2]);
  const expected = `
  p.age = 20;
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("setting nested field", () => {
  const input = `
struct Address {
  var line: string
}
struct Person {
  var age: int
  var address: Address
}
var p: Person
p.address.line = "1 main st"
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[3]);
  const expected = `
  p.address.line = "1 main st";
`;
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
