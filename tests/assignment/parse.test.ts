import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import AssignmentNode from "../../src/types/AssignmentNode";

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
    left_value: "x",
    right_value: "5",
    children: [],
  };
  assert.equal(result.root.children[1], expected);
});

test.run();
