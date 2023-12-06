import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type DeclarationNode from "../../src/types/DeclarationNode";
import type RangeNode from "../../src/types/RangeNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Range parse");

test("exclusive", () => {
  const input = `
var x = 1..2
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "range",
      left_value: {
        node_type: "value",
        value: "1",
        type: "int",
        children: [],
        i: 0,
      } as ValueNode,
      right_value: {
        node_type: "value",
        value: "2",
        type: "int",
        children: [],
        i: 0,
      } as ValueNode,
      inclusive: false,
      children: [],
      i: 0,
    } as RangeNode,
    type: "int[]",
    children: [],
    i: 0,
  };
  assert.equal(result.errors, []);
  assert.equal(
    trim_test_data(result.root.children[0]),
    trim_test_data(expected),
  );
});

test("inclusive", () => {
  const input = `
var x = 1.=2
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "range",
      left_value: {
        node_type: "value",
        value: "1",
        type: "int",
        children: [],
        i: 0,
      } as ValueNode,
      right_value: {
        node_type: "value",
        value: "2",
        type: "int",
        children: [],
        i: 0,
      } as ValueNode,
      inclusive: true,
      children: [],
      i: 0,
    } as RangeNode,
    type: "int[]",
    children: [],
    i: 0,
  };
  assert.equal(result.errors, []);
  assert.equal(
    trim_test_data(result.root.children[0]),
    trim_test_data(expected),
  );
});

test.run();
