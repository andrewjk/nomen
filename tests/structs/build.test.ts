import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Struct build");

test("struct", () => {
	const input = `
struct Person {}
`;
	const parsed = parse(input);
	const result = build(parsed.root);
	const expected = `
typedef struct Person
{
void *_vt;
} Person;
Person Person_init()
{
Person p;
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
	const result = build(parsed.root);
	const expected = `
// Person:
typedef struct Person
{
void *_vt;
char* name;
long age;
} Person;
Person Person_init(char* name)
{
Person p;
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
	const result = build(parsed.root);
	const expected = `
typedef struct Person
{
void *_vt;
} Person;
Person Person_init()
{
Person p;
return p;
}
void Person_greet()
{
}
`;
	expect(parsed.errors).toEqual([]);
	expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("struct with mutating functions", () => {
	const input = `
struct Person {
  var age = 0
  func grow(var self) {
    self.age = self.age + 1
  }
}
`;
	const parsed = parse(input);
	const result = build(parsed.root);
	const expected = `
typedef struct Person
{
void *_vt;
long age;
} Person;
Person Person_init()
{
Person p;
p.age = 0;
return p;
}
void Person_grow(struct Person *self)
{
struct Person _self = *self;
_self.age = _self.age + 1;
}
`;
	expect(parsed.errors).toEqual([]);
	expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
