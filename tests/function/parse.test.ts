import { expect, test } from "vitest";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import FunctionNode from "../../src/nodes/FunctionNode";
import ParameterNode from "../../src/nodes/ParameterNode";
import ReturnNode from "../../src/nodes/ReturnNode";
import RootNode from "../../src/nodes/RootNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Function parse");

test("function", () => {
  const input = `
func add() {}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(1, "mod", "add", "", [], []);
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("function with params", () => {
  const input = `
func add(a: int, b: int) {}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(
    1,
    "mod",
    "add",
    "",
    [new ParameterNode(10, "a", "int"), new ParameterNode(18, "b", "int")],
    [],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("function with params with default value", () => {
  const input = `
func add(a: int, b = 5) {}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(
    1,
    "mod",
    "add",
    "",
    [new ParameterNode(10, "a", "int"), new ParameterNode(18, "b", "int", "5")],
    [],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("function with body", () => {
  const input = `
func add() {
  var x = 5
}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(
    1,
    "mod",
    "add",
    "",
    [],
    [new DeclarationNode(16, "mod", "var", "x", "int", new ValueNode(24, "5", "int"))],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("function with return value", () => {
  const input = `
func add() -> int {
  return 5
}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(
    1,
    "mod",
    "add",
    "int",
    [],
    [new ReturnNode(23, new ValueNode(30, "5", "int"), "int")],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("function followed by function", () => {
  const input = `
func add() {}

func subtract() {}
`;
  const parsed = parse(input);
  const expected = new RootNode([
    new FunctionNode(1, "mod", "add", "", [], []),
    new FunctionNode(16, "mod", "subtract", "", [], []),
  ]);
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root)).toEqual(trim_test_parse(expected));
});
