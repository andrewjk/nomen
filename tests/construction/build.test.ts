import { expect, test } from "vitest";
import build from "../../src/build";
import parse from "../../src/parse";
import trim_test_build from "../trim_test_build";

//const test = suite("Construction build");

test("init struct", () => {
  const input = `
struct Person {
}
var x = Person.init()
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
Person x = Person_init();
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});

test("init struct with params", () => {
  const input = `
struct Person {
  var name: string
}
var x = Person.init("Andrew")
`;
  const parsed = parse(input);
  const result = build(parsed.root);
  const expected = `
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
Person x = Person_init("Andrew");
`;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
});
