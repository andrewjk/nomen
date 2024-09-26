import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Trait build");

test("trait", () => {
  const input = `
trait Person {}

struct Frank: Person {}
`;
  const parsed = parse(input);
  const result = build(parsed.root);
  const expected = `
void *_Frank_Person_funcs[] = {};
void *_Frank_traits[] = {&_Frank_Person_funcs};
typedef struct Frank
{
void *_vt;
} Frank;
Frank Frank_init()
{
Frank f;
f._vt = &_Frank_traits;
return f;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("trait with fields", () => {
  const input = `
trait Person {
  var name: string
  var age = 0
}

struct Frank: Person {
  var name = "Frank"
}
`;
  const parsed = parse(input);
  const result = build(parsed.root);
  const expected = `
void *_Frank_Person_funcs[] = {};
void *_Frank_traits[] = {&_Frank_Person_funcs};
typedef struct Frank
{
void *_vt;
char* name;
int age;
} Frank;
Frank Frank_init()
{
Frank f;
f._vt = &_Frank_traits;
f.name = "Frank";
f.age = 0;
return f;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("trait with functions", () => {
  const input = `
trait Person {
  func greet() {}
}

struct Frank: Person {
  func greet() -> string {
    return "hi"
  }
}
`;
  const parsed = parse(input);
  const result = build(parsed.root);
  const expected = `
typedef struct Person
{
} Person;
void Person_greet(struct Person *self)
{
struct Person _self = *self;
}

void *_Frank_Person_funcs[] = {Frank_greet};
void *_Frank_traits[] = {&_Frank_Person_funcs};
typedef struct Frank
{
void *_vt;
} Frank;
Frank Frank_init()
{
Frank f;
f._vt = &_Frank_traits;
return f;
}
char* Frank_greet(struct Frank *self)
{
struct Frank _self = *self;
return "hi";
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("trait with implemented functions", () => {
  const input = `
trait Person {
  func greet() -> string {
    return "hi"
  }
}

struct Frank: Person {}
`;
  const parsed = parse(input);
  const result = build(parsed.root);
  const expected = `
typedef struct Person
{
} Person;
char* Person_greet(struct Person *self)
{
struct Person _self = *self;
return "hi";
}

// Frank:
void *_Frank_Person_funcs[] = {Person_greet};
void *_Frank_traits[] = {&_Frank_Person_funcs};
typedef struct Frank
{
void *_vt;
} Frank;
Frank Frank_init()
{
Frank f;
f._vt = &_Frank_traits;
return f;
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
