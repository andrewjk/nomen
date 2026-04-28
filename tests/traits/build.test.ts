import { expect, test } from "vite-plus/test";

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
typedef struct Person
{
} Person;
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
typedef struct Person
{
} Person;
void *_Frank_Person_funcs[] = {get_Frank_name, set_Frank_name, get_Frank_age, set_Frank_age};
void *_Frank_traits[] = {&_Frank_Person_funcs};
typedef struct Frank
{
void *_vt;
char* name;
long age;
} Frank;
Frank Frank_init()
{
Frank f;
f._vt = &_Frank_traits;
f.name = "Frank";
f.age = 0;
return f;
}
char* get_Frank_name(struct Frank *self) { return self->name; }
void set_Frank_name(struct Frank *self, char* value) { self->name = value; }
long get_Frank_age(struct Frank *self) { return self->age; }
void set_Frank_age(struct Frank *self, long value) { self->age = value; }`;
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
void Person_greet()
{
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
char* Frank_greet()
{
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
char* Person_greet()
{
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
