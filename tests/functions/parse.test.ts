import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
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
  const parsed = parse(input);
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [],
    return_type: "",
    has_body: true,
    statements: [],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});
``;

test("function with params", () => {
  const input = `
func add(a: int, b: int) {}
`;
  const parsed = parse(input);
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [
      {
        node_type: "param",
        name: "a",
        type: "int",
        start: 0,
      },
      {
        node_type: "param",
        name: "b",
        type: "int",
        start: 0,
      },
    ],
    return_type: "",
    has_body: true,
    statements: [],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("function with params with default value", () => {
  const input = `
func add(a: int, b = 5) {}
`;
  const parsed = parse(input);
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [
      {
        node_type: "param",
        name: "a",
        type: "int",
        start: 0,
      },
      {
        node_type: "param",
        name: "b",
        type: "int",
        default_value: "5",
        start: 0,
      },
    ],
    return_type: "",
    has_body: true,
    statements: [],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("function with return type", () => {
  const input = `
func add() -> int {
  return 1
}
`;
  const parsed = parse(input);
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [],
    return_type: "int",
    has_body: true,
    statements: [
      {
        node_type: "ret",
        value: {
          node_type: "value",
          value: "1",
          type: "int",
          start: 0,
        } as ValueNode,
        type: "int",
        start: 0,
      } as ReturnNode,
    ],
    has_return: true,
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("function with body", () => {
  const input = `
func add() {
  var x = 5
}
`;
  const parsed = parse(input);
  const decl: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "value",
      value: "5",
      type: "int",
      start: 0,
    } as ValueNode,
    type: "int",
    start: 0,
  };
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [],
    return_type: "",
    has_body: true,
    statements: [decl],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("function with return value", () => {
  const input = `
func add() -> int {
  return 5
}
`;
  const parsed = parse(input);
  const ret: ReturnNode = {
    node_type: "ret",
    value: {
      node_type: "value",
      value: "5",
      type: "int",
      start: 0,
    } as ValueNode,
    type: "int",
    start: 0,
  };
  const expected: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [],
    return_type: "int",
    has_body: true,
    has_return: true,
    statements: [ret],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("function followed by function", () => {
  const input = `
func add() {}

func subtract() {}
`;
  const parsed = parse(input);
  const addFunction: FunctionNode = {
    node_type: "func",
    name: "add",
    params: [],
    return_type: "",
    has_body: true,
    statements: [],
    start: 0,
  };
  const subtractFunction: FunctionNode = {
    node_type: "func",
    name: "subtract",
    params: [],
    return_type: "",
    has_body: true,
    statements: [],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(addFunction),
  );
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[1]),
    trim_test_data(subtractFunction),
  );
});

test.run();
