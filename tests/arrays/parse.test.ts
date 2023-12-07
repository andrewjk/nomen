import { suite } from "uvu";
import assert from "uvu/assert";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type ArrayValuesNode from "../../src/types/ArrayValuesNode";
import type DeclarationNode from "../../src/types/DeclarationNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Array parse");

test("declaration with type", () => {
  const input = `
const x: int[]
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "const",
    name: "x",
    type: "int[]",
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[0]),
    trim_test_data(expected),
  );
});

test("declaration with value", () => {
  const input = `
var x = [1, 2, 3]
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "array",
      values: [
        {
          node_type: "value",
          value: "1",
          type: "int",
          children: [],
          i: 0,
        } as ValueNode,
        {
          node_type: "value",
          value: "2",
          type: "int",
          children: [],
          i: 0,
        } as ValueNode,
        {
          node_type: "value",
          value: "3",
          type: "int",
          children: [],
          i: 0,
        } as ValueNode,
      ],
      type: "int[3]",
      children: [],
      i: 0,
    } as ArrayValuesNode,
    type: "int[3]",
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[0]),
    trim_test_data(expected),
  );
});

test.run();
