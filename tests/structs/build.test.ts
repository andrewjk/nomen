import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Struct build");

test("struct", () => {
  const input = `
struct Person {}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
typedef struct Person {
  void *_vt;
} Person;
Person Person__init() {
  Person p;
  p._vt = &_Person_traits;
  return p;
}
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("struct with fields", () => {
  const input = `
struct Person {
  var name: string
  var age = 0
}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
typedef struct Person {
  void *_vt;
  char* name;
  int age;
} Person;
Person Person__init() {
  Person p;
  p._vt = &_Person_traits;
  p.name = "";
  p.age = 0;
  return p;
}
`;
  assert.equal(result.code.trim(), expected.trim());
});

test("struct with functions", () => {
  const input = `
struct Person {
  func greet() {}
}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root.children[0]);
  const expected = `
typedef struct Person {
  void *_vt;
} Person;
Person Person__init() {
  Person p;
  p._vt = &_Person_traits;
  return p;
}
void Person_greet() {
}
`;
  assert.equal(result.code.trim(), expected.trim());
});

test.run();
