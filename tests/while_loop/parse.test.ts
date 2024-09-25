import { expect, test } from "vitest";
import AssignmentNode from "../../src/nodes/AssignmentNode";
import OperationNode from "../../src/nodes/OperationNode";
import ValueNode from "../../src/nodes/ValueNode";
import WhileLoopNode from "../../src/nodes/WhileLoopNode";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("While loop parse");

test("while", () => {
  const input = `
var x = 0
while x < 5 {
  x = x + 1
}
`;
  const parsed = parse(input);
  const expected = new WhileLoopNode(
    11,
    new OperationNode(
      17,
      "<",
      new ValueNode(17, "x", "int"),
      new ValueNode(21, "5", "int"),
      "bool",
    ),
    [
      new AssignmentNode(
        27,
        new ValueNode(27, "x", "int"),
        new OperationNode(
          31,
          "+",
          new ValueNode(31, "x", "int"),
          new ValueNode(35, "1", "int"),
          "int",
        ),
      ),
    ],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("while true", () => {
  const input = `
while true {
  // ...
}
`;
  const parsed = parse(input);
  const expected = new WhileLoopNode(1, new ValueNode(7, "true", "bool"));
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});
