import { expect, test } from "vitest";
import AccessFunctionCallNode from "../../src/nodes/AccessFunctionCallNode";
import AccessNode from "../../src/nodes/AccessNode";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import FunctionCallNode from "../../src/nodes/FunctionCallNode";
import OperationNode from "../../src/nodes/OperationNode";
import Type from "../../src/nodes/Type";
import ValueNode from "../../src/nodes/ValueNode";
import trim_test_parse from "../trim_test_parse";
import parse_with_imports from "../ziglings/parse_with_imports";

//const test = suite("interpolate string parse");

test("interpolate string", () => {
  const input = `
import System

const x = 5
const z = "\\{x} is less than \\{x + 5}!"
`;
  const parsed = parse_with_imports(input);
  //console.log(JSON.stringify(parsed.root.statements[1], null, 2));
  const expected = new DeclarationNode(
    1,
    "mod",
    "const",
    "z",
    new Type("string"),
    new FunctionCallNode(
      0,
      "_string_interpolate_2",
      new Type("string"),
      [
        new ValueNode(0, '"%s is less than %s!"', new Type("string", true)),
        new ValueNode(0, "_param_0", new Type("string")),
        new ValueNode(0, "_param_1", new Type("string")),
      ],
      true,
    ),
  );
  expected.allocations = [
    new DeclarationNode(
      0,
      "private",
      "const",
      "_param_0",
      new Type("string"),
      new AccessNode(
        0,
        new ValueNode(0, "x", new Type("int", true)),
        new AccessFunctionCallNode(0, "to_string", new Type("string")),
      ),
    ),
    new DeclarationNode(
      0,
      "private",
      "const",
      "_param_1",
      new Type("string"),
      new AccessNode(
        0,
        new OperationNode(
          0,
          "+",
          new ValueNode(0, "x", new Type("int", true)),
          new ValueNode(0, "5", new Type("int", true)),
          new Type("int", true),
        ),
        new AccessFunctionCallNode(0, "to_string", new Type("string")),
      ),
    ),
  ];
  //console.log(JSON.stringify(parsed.root.statements[1], null, 2));

  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});
