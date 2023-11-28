import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type AssignmentNode from "../../src/types/AssignmentNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Assignment parse");

test("assignment to var", () => {
  const input = `
var x: int
x = 5
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: AssignmentNode = {
    node_type: "assign",
    left_value: {
      node_type: "value",
      value: "x",
      type: "int",
      children: [],
      i: 0,
    } as ValueNode,
    right_value: {
      node_type: "value",
      value: "5",
      type: "int",
      children: [],
      i: 0,
    } as ValueNode,
    children: [],
    i: 0,
  };
  assert.equal(
    trim_test_data(result.root.children[1]),
    trim_test_data(expected),
  );
});

test.run();
