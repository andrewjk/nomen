import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type DeclarationNode from "../../src/types/DeclarationNode";
import type OperationNode from "../../src/types/OperationNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Operation parse");

test("addition", () => {
  const input = `
var x = 1 + 2
`;
  const parsed = parse(input);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "op",
      op: "+",
      left_value: {
        node_type: "value",
        value: "1",
        type: "int",
        start: 0,
      } as ValueNode,
      right_value: {
        node_type: "value",
        value: "2",
        type: "int",
        start: 0,
      } as ValueNode,
      type: "int",
      start: 0,
    } as OperationNode,
    type: "int",
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("subtraction", () => {
  const input = `
var x = 1 - 2
`;
  const parsed = parse(input);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "op",
      op: "-",
      left_value: {
        node_type: "value",
        value: "1",
        type: "int",
        start: 0,
      } as ValueNode,
      right_value: {
        node_type: "value",
        value: "2",
        type: "int",
        start: 0,
      } as ValueNode,
      type: "int",
      start: 0,
    } as OperationNode,
    type: "int",
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("series", () => {
  const input = `
var x = 1 + 2 - 3
`;
  const parsed = parse(input);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "op",
      op: "+",
      left_value: {
        node_type: "value",
        value: "1",
        type: "int",
        start: 0,
      } as ValueNode,
      right_value: {
        node_type: "op",
        op: "-",
        left_value: {
          node_type: "value",
          value: "2",
          type: "int",
          start: 0,
        } as ValueNode,
        right_value: {
          node_type: "value",
          value: "3",
          type: "int",
          start: 0,
        } as ValueNode,
        type: "int",
        start: 0,
      } as OperationNode,
      type: "int",
      start: 0,
    } as OperationNode,
    type: "int",
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test.run();
