import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import DeclarationNode from "../../src/types/DeclarationNode";
import type FunctionNode from "../../src/types/FunctionNode";
import ReturnNode from "../../src/types/ReturnNode";

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
    has_return: false,
    children: [],
  };
  assert.equal(result.root.children[0], expected);
});

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
        default_value: "",
        children: [],
      },
      {
        node_type: "param",
        name: "b",
        type: "int",
        default_value: "",
        children: [],
      },
    ],
    return_type: "",
    has_return: false,
    children: [],
  };
  assert.equal(result.root.children[0], expected);
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
        default_value: "",
        children: [],
      },
      {
        node_type: "param",
        name: "b",
        type: "int",
        default_value: "5",
        children: [],
      },
    ],
    return_type: "",
    has_return: false,
    children: [],
  };
  assert.equal(result.root.children[0], expected);
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
    has_return: false,
    children: [],
  };
  assert.equal(result.root.children[0], expected);
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
    value: "5",
    type: "int",
    children: [],
  };
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [],
    return_type: "",
    has_return: false,
    children: [decl],
  };
  assert.equal(result.root.children[0], expected);
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
    value: "5",
    type: "int",
    children: [],
  };
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [],
    return_type: "int",
    has_return: true,
    children: [ret],
  };
  assert.equal(result.root.children[0], expected);
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
    has_return: false,
    children: [],
  };
  const subtractFunction: FunctionNode = {
    node_type: "func",
    name: "subtract",
    params: [],
    return_type: "",
    has_return: false,
    children: [],
  };
  assert.equal(result.root.children[0], addFunction);
  assert.equal(result.root.children[1], subtractFunction);
});

test.run();
