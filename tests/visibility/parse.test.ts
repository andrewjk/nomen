import { suite } from "uvu";
import assert from "uvu/assert";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import FunctionNode from "../../src/nodes/FunctionNode";
import ParameterNode from "../../src/nodes/ParameterNode";
import StructNode from "../../src/nodes/StructNode";
import TraitNode from "../../src/nodes/TraitNode";
import Type from "../../src/nodes/Type";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

const test = suite("Visibility parse");

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
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
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
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
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
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("pub trait", () => {
  const input = `
pub trait Person {}
`;
  const parsed = parse(input);
  const expected = new TraitNode(1, "pub", "Person");
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("pub function", () => {
  const input = `
pub func add() {}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(1, "pub", "add", "", [], []);
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("pub fields in struct", () => {
  const input = `
pub struct Person {
  pub var name: string
  sec func greet() {}
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
      new FunctionNode(46, "sec", "greet", "", [], []),
    ],
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("sec var", () => {
  const input = `
sec var x = 1
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "sec",
    "var",
    "x",
    new Type("int"),
    new ValueNode(13, "1", "int"),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("sec const", () => {
  const input = `
sec const x = 3
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "sec",
    "const",
    "x",
    new Type("int"),
    new ValueNode(15, "3", "int"),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("sec struct", () => {
  const input = `
sec struct Person {}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    1,
    "sec",
    "Person",
    [],
    [],
    [new FunctionNode(-1, "sec", "init", "Person", [])],
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("sec trait", () => {
  const input = `
sec trait Person {}
`;
  const parsed = parse(input);
  const expected = new TraitNode(1, "sec", "Person");
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("sec function", () => {
  const input = `
sec func add() {}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(1, "sec", "add", "", [], []);
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

test("sec fields in struct", () => {
  const input = `
pub struct Person {
  sec var name: string
  sec func greet() {}
}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    1,
    "pub",
    "Person",
    [],
    [new DeclarationNode(23, "sec", "var", "name", "string")],
    [
      new FunctionNode(-1, "pub", "init", "Person", []),
      new FunctionNode(46, "sec", "greet", "", [], []),
    ],
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[0]), trim_test_data(expected));
});

// TODO: Need rudimentary scoping
test("accessing sec fields within scope", () => {
  const input = `
struct Person {
  sec var name: string
  sec func greet() -> string {
    return "hi, " + self.name
  }
}
`;
  const parsed = parse(input);
  assert.equal(parsed.errors, []);
});

test.run();
