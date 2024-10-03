import { expect, test } from "vitest";
import AccessFunctionCallNode from "../../src/nodes/AccessFunctionCallNode";
import AccessNode from "../../src/nodes/AccessNode";
import AssignmentNode from "../../src/nodes/AssignmentNode";
import Type from "../../src/nodes/Type";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Assignment parse");

test("assignment to var", () => {
  const input = `
var x: int
x = 5
`;
  const parsed = parse(input);
  const expected = new AssignmentNode(
    12,
    new ValueNode(12, "x", new Type("int")),
    new ValueNode(16, "5", new Type("int", true)),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("trait assignment with struct", () => {
  const input = `
trait Animal {}
struct Dog: Animal {}
var x: Animal
x = Dog.init()
`;
  const parsed = parse(input);
  const expected = new AssignmentNode(
    53,
    new ValueNode(53, "x", new Type("Animal")),
    new AccessNode(
      57,
      new ValueNode(57, "Dog", new Type("Dog")),
      new AccessFunctionCallNode(61, "init", new Type("Dog"), [], true),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[3])).toEqual(trim_test_parse(expected));
});
