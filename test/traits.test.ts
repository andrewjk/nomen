import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("trait build", () => {
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
  var string name
  var int age = 0
}

struct Frank: Person {
  var string name = "Frank"
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
  func greet = () -> {}
}

struct Frank: Person {
  func greet = (out string) -> {
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
  func greet = (out string) -> {
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

  test("struct with multiple traits", () => {
    const input = `
trait Person {
  func greet = (out string) -> {
    return "hi"
  }
}

trait Dancer {
  func dance = () -> {}
}

struct Frank: Person, Dancer {
  func greet = (out string) -> {
    return "hi, frank"
  }
  func dance = () -> {}
}
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

typedef struct Dancer
{
} Dancer;
void Dancer_dance()
{
}

// Frank:
void *_Frank_Person_funcs[] = {Frank_greet};
void *_Frank_Dancer_funcs[] = {Frank_dance};
void *_Frank_traits[] = {&_Frank_Person_funcs, &_Frank_Dancer_funcs};
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
return "hi, frank";
}
void Frank_dance()
{
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("trait errors", () => {
  test("invalid syntax", () => {
    const input = `
trait Person People {}
`;
    const expected = [test_error(input, "Expected {", 2, 14)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("child trait", () => {
    const input = `
trait Person {
  trait People {}
}
`;
    const expected = [test_error(input, "Trait cannot appear here", 3, 3)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("child assignment", () => {
    const input = `
trait Person {
  var int x
  x = 5
}
`;
    const expected = [test_error(input, "Assignment cannot appear here", 4, 3)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("unknown trait", () => {
    const input = `
struct Frank: Person {
}
`;
    const expected = [test_error(input, "Unknown trait: Person", 2, 1)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
