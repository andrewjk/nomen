import { suite } from "uvu";
import assert from "uvu/assert";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import FunctionNode from "../../src/nodes/FunctionNode";
import ParameterNode from "../../src/nodes/ParameterNode";
import StructNode from "../../src/nodes/StructNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

const test = suite("Struct parse");

test("struct", () => {
  const input = `
struct Person {}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    1,
    "def",
    "Person",
    [],
    [],
    [new FunctionNode(-1, "def", "init", "Person", [])],
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("struct with fields", () => {
  const input = `
struct Person {
  var name: string
  var age = 0
}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    1,
    "def",
    "Person",
    [],
    [
      new DeclarationNode(19, "def", "var", "name", "string"),
      new DeclarationNode(38, "def", "var", "age", "int", new ValueNode(48, "0", "int")),
    ],
    [new FunctionNode(-1, "def", "init", "Person", [new ParameterNode(-1, "name", "string")])],
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("struct with functions", () => {
  const input = `
struct Person {
  func greet() {}
}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    1,
    "def",
    "Person",
    [],
    [],
    [
      new FunctionNode(-1, "def", "init", "Person", []),
      new FunctionNode(19, "def", "greet", "", [], []),
    ],
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test.run();
