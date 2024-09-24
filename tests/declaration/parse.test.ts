import { expect, test } from "vitest";
import AccessInvocationNode from "../../src/nodes/AccessInvocationNode";
import AccessNode from "../../src/nodes/AccessNode";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

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
    "int",
    new ValueNode(11, "5", "int"),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[0])).toEqual(trim_test_data(expected));
});

test("const with type", () => {
  const input = `
const x: int
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(1, "mod", "const", "x", "int");
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[0])).toEqual(trim_test_data(expected));
});

test("var with value", () => {
  const input = `
var x = 5
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(1, "mod", "var", "x", "int", new ValueNode(9, "5", "int"));
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[0])).toEqual(trim_test_data(expected));
});

test("var with type", () => {
  const input = `
var x: int
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(1, "mod", "var", "x", "int");
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[0])).toEqual(trim_test_data(expected));
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
    "Animal",
    new AccessNode(
      55,
      new ValueNode(55, "Dog", "Dog"),
      new AccessInvocationNode(59, "init", [], "Dog", true),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[2])).toEqual(trim_test_data(expected));
});
