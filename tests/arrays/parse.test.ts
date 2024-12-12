import { expect, test } from "vitest";
import AccessFunctionCallNode from "../../src/nodes/AccessFunctionCallNode";
import AccessIndexNode from "../../src/nodes/AccessIndexNode";
import AccessNode from "../../src/nodes/AccessNode";
import ArrayValuesNode from "../../src/nodes/ArrayValuesNode";
import AssignmentNode from "../../src/nodes/AssignmentNode";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import Type from "../../src/nodes/Type";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Array parse");

test("declaration with type", () => {
  const input = `
const x: int[]
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(1, "mod", "const", "x", new Type("int", undefined, true));
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
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
    new Type("int", true, true, new ValueNode(-1, "3", new Type("int"))),
    new ArrayValuesNode(
      9,
      [
        new ValueNode(10, "1", new Type("int", true)),
        new ValueNode(13, "2", new Type("int", true)),
        new ValueNode(16, "3", new Type("int", true)),
      ],
      new Type("int", true, true, new ValueNode(-1, "3", new Type("int"))),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
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
    new Type("Animal", undefined, true, new ValueNode(-1, "2", new Type("int"))),
    new ArrayValuesNode(
      79,
      [
        new AccessNode(
          80,
          new ValueNode(80, "Dog", new Type("Dog")),
          new AccessFunctionCallNode(84, "init", new Type("Dog"), [], true),
        ),
        new AccessNode(
          92,
          new ValueNode(92, "Cat", new Type("Cat")),
          new AccessFunctionCallNode(96, "init", new Type("Cat"), [], true),
        ),
      ],
      new Type("Animal", undefined, true, new ValueNode(-1, "2", new Type("int"))),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[3])).toEqual(trim_test_parse(expected));
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
    new ValueNode(
      77,
      "x",
      new Type("Animal", undefined, true, new ValueNode(-1, "2", new Type("int"))),
    ),
    new ArrayValuesNode(
      81,
      [
        new AccessNode(
          82,
          new ValueNode(82, "Dog", new Type("Dog")),
          new AccessFunctionCallNode(86, "init", new Type("Dog"), [], true),
        ),
        new AccessNode(
          94,
          new ValueNode(94, "Cat", new Type("Cat")),
          new AccessFunctionCallNode(98, "init", new Type("Cat"), [], true),
        ),
      ],
      new Type("Animal", undefined, true, new ValueNode(-1, "2", new Type("int"))),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[4])).toEqual(trim_test_parse(expected));
});

test("access value in array", () => {
  const input = `
const nums = [ 0, 1, 2, 3 ]
const second = nums[1]
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    77,
    "mod",
    "const",
    "second",
    new Type("int", true),
    new AccessNode(
      82,
      new ValueNode(
        82,
        "nums",
        new Type("int", true, true, new ValueNode(88, "4", new Type("int"))),
      ),
      new AccessIndexNode(86, new ValueNode(86, "1", new Type("int", true)), new Type("int", true)),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});
