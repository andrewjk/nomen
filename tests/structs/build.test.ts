import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Struct build");

test("struct", () => {
  const input = `
struct Person {}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
typedef struct Person
{
void *_vt;
} Person;
Person Person_init()
{
Person p;
p._vt = &_Person_traits;
return p;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("struct with fields", () => {
  const input = `
struct Person {
  var name: string
  var age = 0
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
// Person:
typedef struct Person
{
void *_vt;
char* name;
int age;
} Person;
Person Person_init(char* name)
{
Person p;
p._vt = &_Person_traits;
p.name = name;
p.age = 0;
return p;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("struct with functions", () => {
  const input = `
struct Person {
  func greet() {}
}
`;
  const parsed = parse(input);
  const result = build(parsed.root.statements[0]);
  const expected = `
typedef struct Person
{
void *_vt;
} Person;
Person Person_init()
{
Person p;
p._vt = &_Person_traits;
return p;
}
void Person_greet(struct Person *self)
{
struct Person _self = *self;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
