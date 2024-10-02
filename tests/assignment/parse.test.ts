import { expect, test } from "vitest";
import AccessFunctionCallNode from "../../src/nodes/AccessFunctionCallNode";
import AccessNode from "../../src/nodes/AccessNode";
import AssignmentNode from "../../src/nodes/AssignmentNode";
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
    new ValueNode(12, "x", "int"),
    new ValueNode(16, "5", "int"),
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
    new ValueNode(53, "x", "Animal"),
    new AccessNode(
      57,
      new ValueNode(57, "Dog", "Dog"),
      new AccessFunctionCallNode(61, "init", "Dog", [], true),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[3])).toEqual(trim_test_parse(expected));
});
