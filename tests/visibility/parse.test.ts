import { expect, test } from "vitest";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import FunctionNode from "../../src/nodes/FunctionNode";
import ParameterNode from "../../src/nodes/ParameterNode";
import StructNode from "../../src/nodes/StructNode";
import TraitNode from "../../src/nodes/TraitNode";
import Type from "../../src/nodes/Type";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Visibility parse");

test("pub var", () => {
  const input = `
pub var x = 1
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "pub",
    "var",
    "x",
    new Type("int"),
    new ValueNode(13, "1", "int"),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("pub const", () => {
  const input = `
pub const x = 3
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "pub",
    "const",
    "x",
    new Type("int"),
    new ValueNode(15, "3", "int"),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("pub struct", () => {
  const input = `
pub struct Person {}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    1,
    "pub",
    "Person",
    [],
    [],
    [new FunctionNode(-1, "pub", "init", "Person", [])],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("pub trait", () => {
  const input = `
pub trait Person {}
`;
  const parsed = parse(input);
  const expected = new TraitNode(1, "pub", "Person");
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("pub function", () => {
  const input = `
pub func add() {}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(1, "pub", "add", "", [], []);
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("pub fields in struct", () => {
  const input = `
pub struct Person {
  pub var name: string
  private func greet() {}
}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    1,
    "pub",
    "Person",
    [],
    [new DeclarationNode(23, "pub", "var", "name", "string")],
    [
      new FunctionNode(-1, "pub", "init", "Person", [new ParameterNode(-1, "name", "string")]),
      new FunctionNode(46, "private", "greet", "", [], []),
    ],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private var", () => {
  const input = `
private var x = 1
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "private",
    "var",
    "x",
    new Type("int"),
    new ValueNode(13, "1", "int"),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private const", () => {
  const input = `
private const x = 3
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "private",
    "const",
    "x",
    new Type("int"),
    new ValueNode(15, "3", "int"),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private struct", () => {
  const input = `
private struct Person {}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    1,
    "private",
    "Person",
    [],
    [],
    [new FunctionNode(-1, "private", "init", "Person", [])],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private trait", () => {
  const input = `
private trait Person {}
`;
  const parsed = parse(input);
  const expected = new TraitNode(1, "private", "Person");
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private function", () => {
  const input = `
private func add() {}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(1, "private", "add", "", [], []);
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private fields in struct", () => {
  const input = `
pub struct Person {
  private var name: string
  private func greet() {}
}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    1,
    "pub",
    "Person",
    [],
    [new DeclarationNode(23, "private", "var", "name", "string")],
    [
      new FunctionNode(-1, "pub", "init", "Person", []),
      new FunctionNode(46, "private", "greet", "", [], []),
    ],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

// TODO: Need rudimentary scoping
test("accessing private fields within scope", () => {
  const input = `
struct Person {
  private var name: string
  private func greet() -> string {
    return "hi, " + self.name
  }
}
`;
  const parsed = parse(input);
  expect(parsed.errors).toEqual([]);
});
