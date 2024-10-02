import { expect, test } from "vitest";
import AccessFieldNode from "../../src/nodes/AccessFieldNode";
import AccessFunctionCallNode from "../../src/nodes/AccessFunctionCallNode";
import AccessNode from "../../src/nodes/AccessNode";
import AssignmentNode from "../../src/nodes/AssignmentNode";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import ValueNode from "../../src/nodes/ValueNode";
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
    "int",
    new AccessNode(56, new ValueNode(56, "p", "Person"), new AccessFieldNode(58, "age", "int")),
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
    "string",
    new AccessNode(
      117,
      new AccessNode(
        117,
        new ValueNode(117, "p", "Person"),
        new AccessFieldNode(119, "address", "Address"),
      ),
      new AccessFieldNode(127, "line", "string"),
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
    new AccessNode(48, new ValueNode(48, "p", "Person"), new AccessFieldNode(50, "age", "int")),
    new ValueNode(56, "20", "int"),
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
        new ValueNode(109, "p", "Person"),
        new AccessFieldNode(111, "address", "Address"),
      ),
      new AccessFieldNode(119, "line", "string"),
    ),
    new ValueNode(126, '"1 main st"', "string"),
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
    "int",
    new AccessNode(
      81,
      new ValueNode(81, "p", "Person"),
      new AccessFunctionCallNode(83, "age", "int", [], true),
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
    "string",
    new AccessNode(
      153,
      new AccessNode(
        153,
        new ValueNode(153, "p", "Person"),
        new AccessFieldNode(155, "address", "Address"),
      ),
      new AccessFunctionCallNode(163, "line", "string", [], true),
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
    "string",
    new AccessNode(
      167,
      new AccessNode(
        167,
        new ValueNode(167, "p", "Person"),
        new AccessFunctionCallNode(169, "address", "Address", [], true),
      ),
      new AccessFieldNode(179, "line", "string"),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_parse_tree(parsed.root.statements[3])).toEqual(trim_parse_tree(expected));
});
