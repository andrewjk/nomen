import { expect, test } from "vitest";
import AccessFunctionNode from "../../src/nodes/AccessFunctionNode";
import AccessNode from "../../src/nodes/AccessNode";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Construction parse");

test("init struct", () => {
  const input = `
struct Person {
}
var x = Person.init()
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    19,
    "mod",
    "var",
    "x",
    "Person",
    new AccessNode(
      27,
      new ValueNode(27, "Person", "Person"),
      new AccessFunctionNode(34, "init", [], "Person", true),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("init struct with params", () => {
  const input = `
struct Person {
  var name: string
}
var x = Person.init("Andrew")
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    38,
    "mod",
    "var",
    "x",
    "Person",
    new AccessNode(
      46,
      new ValueNode(46, "Person", "Person"),
      new AccessFunctionNode(53, "init", [new ValueNode(58, '"Andrew"', "string")], "Person", true),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("init struct with default values", () => {
  const input = `
struct Person {
  var name = "?"
}
var x = Person.init()
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    36,
    "mod",
    "var",
    "x",
    "Person",
    new AccessNode(
      44,
      new ValueNode(44, "Person", "Person"),
      new AccessFunctionNode(51, "init", [], "Person", true),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});
