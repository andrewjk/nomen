import { expect, test } from "vite-plus/test";

import AccessFunctionCallNode from "../../src/nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../src/nodes/AccessNode.ts";
import DeclarationNode from "../../src/nodes/DeclarationNode.ts";
import Type from "../../src/nodes/Type.ts";
import ValueNode from "../../src/nodes/ValueNode.ts";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Declaration parse");

test("const with value", () => {
  const input = `
const x = 5
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "mod",
    "const",
    "x",
    new Type("int", true),
    new ValueNode(11, "5", new Type("int", true)),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("const with type", () => {
  const input = `
const x: int
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(1, "mod", "const", "x", new Type("int"));
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("var with value", () => {
  const input = `
var x = 5
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "mod",
    "var",
    "x",
    new Type("int", true),
    new ValueNode(9, "5", new Type("int", true)),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("var with type", () => {
  const input = `
var x: int
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(1, "mod", "var", "x", new Type("int"));
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("trait var with struct", () => {
  const input = `
trait Animal {}
struct Dog: Animal {}
var x: Animal = Dog.init()
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    39,
    "mod",
    "var",
    "x",
    new Type("Animal"),
    new AccessNode(
      55,
      new ValueNode(55, "Dog", new Type("Dog")),
      new AccessFunctionCallNode(59, "init", new Type("Dog"), [], true),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[2])).toEqual(trim_test_parse(expected));
});
