import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Function build");

test("function", () => {
  const input = `
func add() {}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
void add()
{
}
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("function with params", () => {
  const input = `
func add(a: int, b: int) {}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
void add(int a, int b)
{
}
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("function with params with default value", () => {
  const input = `
func add(a: int, b = 5) {}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
void add(int a, int b)
{
}
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("function with return type", () => {
  const input = `
func add() -> int {}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
void add()
{
}
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("function with body", () => {
  const input = `
func add() {
  var x = 5
}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
void add()
{
int x = 5;
}
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("function with return value", () => {
  const input = `
func add() -> int {
  return 5
}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
void add()
{
return 5;
}
`;
  assert.equal(result.code.trim(), expected.trim());
});

/*
test("function followed by function", () => {
  const input = `
func add() {}

func subtract() {}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
void add() {

}

void subtract() {

}
`;
  assert.equal(result.code.trim(), expected.trim());
});
*/
test.run();
