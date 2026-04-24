import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("struct build", () => {
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
  var string name
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
  func greet = () -> {}
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
  var int age = 0
  func grow = (var self) -> {
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

  test("struct with function returning value", () => {
    const input = `
struct Person {
  var string name
  func get_name = (self, out string) -> {
    return self.name
  }
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
} Person;
Person Person_init(char* name)
{
Person p;
p.name = name;
return p;
}
char* Person_get_name(struct Person *self)
{
struct Person _self = *self;
return _self.name;
}
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("struct errors", () => {
  test("invalid syntax", () => {
    const input = `
struct Person People {}
`;
    const expected = [test_error(input, "Expected {", 2, 15)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("child struct", () => {
    const input = `
struct Person {
  struct People {}
}
`;
    const expected = [test_error(input, "Struct cannot appear here", 3, 3)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("child assignment", () => {
    const input = `
struct Person {
  var int x
  x = 5
}
`;
    const expected = [test_error(input, "Assignment cannot appear here", 4, 3)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
