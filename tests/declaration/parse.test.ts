import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type DeclarationNode from "../../src/types/DeclarationNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Declaration parse");

test("const with value", () => {
  const input = `
const x = 5
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "const",
    name: "x",
    value: {
      node_type: "value",
      value: "5",
      type: "int",
      children: [],
      i: 0,
    } as ValueNode,
    type: "int",
    children: [],
    i: 0,
  };
  assert.equal(result.errors, []);
  assert.equal(
    trim_test_data(result.root.children[0]),
    trim_test_data(expected),
  );
});

test("const with type", () => {
  const input = `
const x: int
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "const",
    name: "x",
    type: "int",
    children: [],
    i: 0,
  };
  assert.equal(result.errors, []);
  assert.equal(
    trim_test_data(result.root.children[0]),
    trim_test_data(expected),
  );
});

test("var with value", () => {
  const input = `
var x = 5
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "value",
      value: "5",
      type: "int",
      children: [],
      i: 0,
    } as ValueNode,
    type: "int",
    children: [],
    i: 0,
  };
  assert.equal(result.errors, []);
  assert.equal(
    trim_test_data(result.root.children[0]),
    trim_test_data(expected),
  );
});

test("var with type", () => {
  const input = `
var x: int
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    type: "int",
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
