import { suite } from "uvu";
import assert from "uvu/assert";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import FunctionNode from "../../src/nodes/FunctionNode";
import ParameterNode from "../../src/nodes/ParameterNode";
import ReturnNode from "../../src/nodes/ReturnNode";
import RootNode from "../../src/nodes/RootNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

const test = suite("Function parse");

test("function", () => {
  const input = `
func add() {}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(1, "add", "", [], []);
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("function with params", () => {
  const input = `
func add(a: int, b: int) {}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(
    1,
    "add",
    "",
    [new ParameterNode(10, "a", "int"), new ParameterNode(18, "b", "int")],
    [],
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("function with params with default value", () => {
  const input = `
func add(a: int, b = 5) {}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(
    1,
    "add",
    "",
    [new ParameterNode(10, "a", "int"), new ParameterNode(18, "b", "int", "5")],
    [],
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
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
    "add",
    "",
    [],
    [new DeclarationNode(16, "var", "x", "int", new ValueNode(24, "5", "int"))],
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
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
    "add",
    "int",
    [],
    [new ReturnNode(23, new ValueNode(30, "5", "int"), "int")],
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("function followed by function", () => {
  const input = `
func add() {}

func subtract() {}
`;
  const parsed = parse(input);
  const expected = new RootNode([
    new FunctionNode(1, "add", "", [], []),
    new FunctionNode(16, "subtract", "", [], []),
  ]);
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root), trim_test_data(expected));
});

test.run();
