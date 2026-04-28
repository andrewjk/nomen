import { expect, test } from "vite-plus/test";

import AccessFieldNode from "../../src/nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../../src/nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../src/nodes/AccessNode.ts";
import AssignmentNode from "../../src/nodes/AssignmentNode.ts";
import DeclarationNode from "../../src/nodes/DeclarationNode.ts";
import Type from "../../src/nodes/Type.ts";
import ValueNode from "../../src/nodes/ValueNode.ts";
import parse from "../../src/parse";
import trim_parse_tree from "../trim_test_parse";

//const test = suite("Access parse");

test("getting field", () => {
  const input = `
struct Person {
  var age: int
}
var p: Person
var x = p.age
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    48,
    "mod",
    "var",
    "x",
    new Type("int"),
    new AccessNode(
      56,
      new ValueNode(56, "p", new Type("Person")),
      new AccessFieldNode(58, "age", new Type("int")),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_parse_tree(parsed.root.statements[2])).toEqual(trim_parse_tree(expected));
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
  const expected = new DeclarationNode(
    109,
    "mod",
    "var",
    "x",
    new Type("string"),
    new AccessNode(
      117,
      new AccessNode(
        117,
        new ValueNode(117, "p", new Type("Person")),
        new AccessFieldNode(119, "address", new Type("Address")),
      ),
      new AccessFieldNode(127, "line", new Type("string")),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_parse_tree(parsed.root.statements[3])).toEqual(trim_parse_tree(expected));
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
  const expected = new AssignmentNode(
    48,
    new AccessNode(
      48,
      new ValueNode(48, "p", new Type("Person")),
      new AccessFieldNode(50, "age", new Type("int")),
    ),
    new ValueNode(56, "20", new Type("int", true)),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_parse_tree(parsed.root.statements[2])).toEqual(trim_parse_tree(expected));
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
  const expected = new AssignmentNode(
    109,
    new AccessNode(
      109,
      new AccessNode(
        109,
        new ValueNode(109, "p", new Type("Person")),
        new AccessFieldNode(111, "address", new Type("Address")),
      ),
      new AccessFieldNode(119, "line", new Type("string")),
    ),
    new ValueNode(126, '"1 main st"', new Type("string", true)),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_parse_tree(parsed.root.statements[3])).toEqual(trim_parse_tree(expected));
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
  const expected = new DeclarationNode(
    73,
    "mod",
    "var",
    "x",
    new Type("int", true),
    new AccessNode(
      81,
      new ValueNode(81, "p", new Type("Person")),
      new AccessFunctionCallNode(83, "age", new Type("int", true), [], true),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_parse_tree(parsed.root.statements[2])).toEqual(trim_parse_tree(expected));
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
  const expected = new DeclarationNode(
    145,
    "mod",
    "var",
    "x",
    new Type("string", true),
    new AccessNode(
      153,
      new AccessNode(
        153,
        new ValueNode(153, "p", new Type("Person")),
        new AccessFieldNode(155, "address", new Type("Address")),
      ),
      new AccessFunctionCallNode(163, "line", new Type("string", true), [], true),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_parse_tree(parsed.root.statements[3])).toEqual(trim_parse_tree(expected));
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
  const expected = new DeclarationNode(
    159,
    "mod",
    "var",
    "x",
    new Type("string"),
    new AccessNode(
      167,
      new AccessNode(
        167,
        new ValueNode(167, "p", new Type("Person")),
        new AccessFunctionCallNode(169, "address", new Type("Address"), [], true),
      ),
      new AccessFieldNode(179, "line", new Type("string")),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_parse_tree(parsed.root.statements[3])).toEqual(trim_parse_tree(expected));
});
