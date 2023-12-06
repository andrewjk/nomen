import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type DeclarationNode from "../../src/types/DeclarationNode";
import type FunctionNode from "../../src/types/FunctionNode";
import type ReturnNode from "../../src/types/ReturnNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Function parse");

test("function", () => {
  const input = `
func add() {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [],
    return_type: "",
    has_body: true,
    children: [],
    i: 0,
  };
  assert.equal(
    trim_test_data(result.root.children[0]),
    trim_test_data(expected),
  );
});
``;

test("function with params", () => {
  const input = `
func add(a: int, b: int) {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [
      {
        node_type: "param",
        name: "a",
        type: "int",
        children: [],
        i: 0,
      },
      {
        node_type: "param",
        name: "b",
        type: "int",
        children: [],
        i: 0,
      },
    ],
    return_type: "",
    has_body: true,
    children: [],
    i: 0,
  };
  assert.equal(
    trim_test_data(result.root.children[0]),
    trim_test_data(expected),
  );
});

test("function with params with default value", () => {
  const input = `
func add(a: int, b = 5) {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [
      {
        node_type: "param",
        name: "a",
        type: "int",
        children: [],
        i: 0,
      },
      {
        node_type: "param",
        name: "b",
        type: "int",
        default_value: "5",
        children: [],
        i: 0,
      },
    ],
    return_type: "",
    has_body: true,
    children: [],
    i: 0,
  };
  assert.equal(
    trim_test_data(result.root.children[0]),
    trim_test_data(expected),
  );
});

test("function with return type", () => {
  const input = `
func add() -> int {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [],
    return_type: "int",
    has_body: true,
    children: [
      {
        node_type: "ret",
        value: {
          node_type: "value",
          value: "1",
          type: "int",
          children: [],
          i: 0,
        } as ValueNode,
        type: "int",
        children: [],
        i: 0,
      } as ReturnNode,
    ],
    has_return: true,
    i: 0,
  };
  assert.equal(
    trim_test_data(result.root.children[0]),
    trim_test_data(expected),
  );
});

test("function with body", () => {
  const input = `
func add() {
  var x = 5
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const decl: DeclarationNode = {
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
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [],
    return_type: "",
    has_body: true,
    children: [decl],
    i: 0,
  };
  assert.equal(
    trim_test_data(result.root.children[0]),
    trim_test_data(expected),
  );
});

test("function with return value", () => {
  const input = `
func add() -> int {
  return 5
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const ret: ReturnNode = {
    node_type: "ret",
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
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [],
    return_type: "int",
    has_body: true,
    has_return: true,
    children: [ret],
    i: 0,
  };
  assert.equal(
    trim_test_data(result.root.children[0]),
    trim_test_data(expected),
  );
});

test("function followed by function", () => {
  const input = `
func add() {}

func subtract() {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const addFunction: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [],
    return_type: "",
    has_body: true,
    children: [],
    i: 0,
  };
  const subtractFunction: FunctionNode = {
    node_type: "func",
    name: "subtract",
    params: [],
    return_type: "",
    has_body: true,
    children: [],
    i: 0,
  };
  assert.equal(
    trim_test_data(result.root.children[0]),
    trim_test_data(addFunction),
  );
  assert.equal(
    trim_test_data(result.root.children[1]),
    trim_test_data(subtractFunction),
  );
});

test.run();
