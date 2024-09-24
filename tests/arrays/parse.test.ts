import { expect, test } from "vitest";
import AccessInvocationNode from "../../src/nodes/AccessInvocationNode";
import AccessNode from "../../src/nodes/AccessNode";
import ArrayValuesNode from "../../src/nodes/ArrayValuesNode";
import AssignmentNode from "../../src/nodes/AssignmentNode";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import Type from "../../src/nodes/Type";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

//const test = suite("Array parse");

test("declaration with type", () => {
  const input = `
const x: int[]
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(1, "mod", "const", "x", new Type("int", true));
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[0])).toEqual(trim_test_data(expected));
});

test("declaration with value", () => {
  const input = `
var x = [1, 2, 3]
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "mod",
    "var",
    "x",
    new Type("int", true, new ValueNode(-1, "3", "int")),
    new ArrayValuesNode(
      9,
      [new ValueNode(10, "1", "int"), new ValueNode(13, "2", "int"), new ValueNode(16, "3", "int")],
      new Type("int", true, new ValueNode(-1, "3", "int")),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[0])).toEqual(trim_test_data(expected));
});

test("declaration of trait array with type and structs", () => {
  const input = `
trait Animal {}
struct Dog: Animal {}
struct Cat: Animal {}
var x: Animal[] = [Dog.init(), Cat.init()]
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    61,
    "mod",
    "var",
    "x",
    new Type("Animal", true, new ValueNode(-1, "2", "int")),
    new ArrayValuesNode(
      79,
      [
        new AccessNode(
          80,
          new ValueNode(80, "Dog", "Dog"),
          new AccessInvocationNode(84, "init", [], "Dog", true),
        ),
        new AccessNode(
          92,
          new ValueNode(92, "Cat", "Cat"),
          new AccessInvocationNode(96, "init", [], "Cat", true),
        ),
      ],
      new Type("Animal", true, new ValueNode(-1, "2", "int")),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[3])).toEqual(trim_test_data(expected));
});

test("assignment of trait array with structs", () => {
  const input = `
trait Animal {}
struct Dog: Animal {}
struct Cat: Animal {}
var x: Animal[]
x = [Dog.init(), Cat.init()]
`;
  const parsed = parse(input);
  const expected = new AssignmentNode(
    77,
    new ValueNode(77, "x", new Type("Animal", true, new ValueNode(-1, "2", "int"))),
    new ArrayValuesNode(
      81,
      [
        new AccessNode(
          82,
          new ValueNode(82, "Dog", "Dog"),
          new AccessInvocationNode(86, "init", [], "Dog", true),
        ),
        new AccessNode(
          94,
          new ValueNode(94, "Cat", "Cat"),
          new AccessInvocationNode(98, "init", [], "Cat", true),
        ),
      ],
      new Type("Animal", true, new ValueNode(-1, "2", "int")),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[4])).toEqual(trim_test_data(expected));
});
