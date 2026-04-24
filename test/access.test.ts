import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("access build", () => {
  test("getting field", () => {
    const input = `
struct Person {
  var int age
}
var Person p
var x = p.age
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
typedef struct Person
{
void *_vt;
long age;
} Person;
Person Person_init(long age)
{
Person p;
p.age = age;
return p;
}
Person p;
long x = p.age;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("getting nested field", () => {
    const input = `
struct Address {
  var string line
}
struct Person {
  var int age
  var Address address
}
var Person p
var x = p.address.line
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
typedef struct Address
{
void *_vt;
char* line;
} Address;
Address Address_init(char* line)
{
Address a;
a.line = line;
return a;
}
typedef struct Person
{
void *_vt;
long age;
Address address;
} Person;
Person Person_init(long age, Address address)
{
Person p;
p.age = age;
p.address = address;
return p;
}
Person p;
char* x = p.address.line;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("setting field", () => {
    const input = `
struct Person {
  var int age
}
var Person p
p.age = 20
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
typedef struct Person
{
void *_vt;
long age;
} Person;
Person Person_init(long age)
{
Person p;
p.age = age;
return p;
}
Person p;
p.age = 20;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("setting nested field", () => {
    const input = `
struct Address {
  var string line
}
struct Person {
  var int age
  var Address address
}
var Person p
p.address.line = "1 main st"
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
typedef struct Address
{
void *_vt;
char* line;
} Address;
Address Address_init(char* line)
{
Address a;
a.line = line;
return a;
}
typedef struct Person
{
void *_vt;
long age;
Address address;
} Person;
Person Person_init(long age, Address address)
{
Person p;
p.age = age;
p.address = address;
return p;
}
Person p;
p.address.line = "1 main st";
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("getting function", () => {
    const input = `
struct Person {
  func age = (out int) -> {
    return 20
  }
}
var Person p
var x = p.age()
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
long Person_age()
{
return 20;
}
Person p;
long x = Person_age();
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("getting function after field", () => {
    const input = `
struct Address {
  func line = (out string) -> {
    return "123 main st"
  }
}
struct Person {
  var int age
  var Address address
}
var Person p
var x = p.address.line()
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
typedef struct Address
{
void *_vt;
} Address;
Address Address_init()
{
Address a;
return a;
}
char* Address_line()
{
return "123 main st";
}
typedef struct Person
{
void *_vt;
long age;
Address address;
} Person;
Person Person_init(long age, Address address)
{
Person p;
p.age = age;
p.address = address;
return p;
}
Person p;
char* x = Address_line();
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("getting field after function", () => {
    const input = `
struct Address {
  var string line
}
struct Person {
  var int age
  func address = (out Address) -> {
    return Address("123 main st")
  }
}
var Person p
var x = p.address().line
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
typedef struct Address
{
void *_vt;
char* line;
} Address;
Address Address_init(char* line)
{
Address a;
a.line = line;
return a;
}
typedef struct Person
{
void *_vt;
long age;
} Person;
Person Person_init(long age)
{
Person p;
p.age = age;
return p;
}
struct Address Person_address()
{
return Address_init("123 main st");
}
Person p;
char* x = Person_address().line;
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("access errors", () => {
  test("type mismatch getting field", () => {
    const input = `
struct Person {
  var string name
}
var Person p
var int x = p.name
`;
    const expected = [
      test_error(input, "Type mismatch in declaration: string (expected int)", 6, 13),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("type mismatch setting field", () => {
    const input = `
struct Person {
  var int age
}
var Person p
p.age = "hi"
`;
    const expected = [test_error(input, "Type mismatch in assignment: string (expected int)", 6, 9)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("unknown target", () => {
    const input = `
var age = person.age
`;
    const expected = [test_error(input, "Unknown value: person", 2, 11)];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
