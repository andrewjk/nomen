import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";

//const test = suite("Trait build");

function trimCode(code: string) {
  return code
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();
}

test("trait", () => {
  const input = `
trait Person {}

struct Frank: Person {}
`;
  const parsed = parse(input);
  const result = build(parsed.root);
  const expected = `
void **_get_trait_func(void **obj, int trait_index, int func_index)
{
void **trait = *(obj + trait_index);
return *(trait + func_index);
}

// Frank:
void *_Frank_Person_funcs[] = {};
void *_Frank_traits[] = {_Frank_Person_funcs};
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
  expect(trimCode(result.code)).toEqual(expected.trim());
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
void **_get_trait_func(void **obj, int trait_index, int func_index)
{
void **trait = *(obj + trait_index);
return *(trait + func_index);
}

// Frank:
void *_Frank_Person_funcs[] = {};
void *_Frank_traits[] = {_Frank_Person_funcs};
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
  expect(trimCode(result.code)).toEqual(expected.trim());
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
void **_get_trait_func(void **obj, int trait_index, int func_index)
{
void **trait = *(obj + trait_index);
return *(trait + func_index);
}

// Person:
typedef struct Person
{
} Person;
void Person_greet(struct Person *self)
{
struct Person zz = *self;
}

// Frank:
void *_Frank_Person_funcs[] = {Frank_greet};
void *_Frank_traits[] = {_Frank_Person_funcs};
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
struct Frank zz = *self;
return "hi";
}
`;
  expect(parsed.errors).toEqual([]);
  expect(trimCode(result.code)).toEqual(expected.trim());
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
void **_get_trait_func(void **obj, int trait_index, int func_index)
{
void **trait = *(obj + trait_index);
return *(trait + func_index);
}

// Person:
typedef struct Person
{
} Person;
char* Person_greet(struct Person *self)
{
struct Person zz = *self;
return "hi";
}

// Frank:
void *_Frank_Person_funcs[] = {Person_greet};
void *_Frank_traits[] = {_Frank_Person_funcs};
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
  expect(trimCode(result.code)).toEqual(expected.trim());
});
