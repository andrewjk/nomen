import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Access build");

test("getting field", () => {
	const input = `
struct Person {
  var age: int
}
var p: Person
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
  var line: string
}
struct Person {
  var age: int
  var address: Address
}
var p: Person
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
  var age: int
}
var p: Person
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
  var line: string
}
struct Person {
  var age: int
  var address: Address
}
var p: Person
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
  func age() -> int {
    return 20
  }
}
var p: Person
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
  func line() -> string {
    return "123 main st"
  }
}
struct Person {
  var age: int
  var address: Address
}
var p: Person
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
  var line: string
}
struct Person {
  var age: int
  func address() -> Address {
    return Address.init("123 main st")
  }
}
var p: Person
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
Address Person_address()
{
return Address_init("123 main st");
}
Person p;
char* x = Person_address().line;
`;
	expect(parsed.errors).toEqual([]);
	expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
