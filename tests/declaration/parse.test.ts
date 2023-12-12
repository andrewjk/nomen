import { suite } from "uvu";
import assert from "uvu/assert";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

const test = suite("Declaration parse");

test("const with value", () => {
  const input = `
const x = 5
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "const",
    "x",
    "int",
    new ValueNode(11, "5", "int"),
  );
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("const with type", () => {
  const input = `
const x: int
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(1, "const", "x", "int");
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("var with value", () => {
  const input = `
var x = 5
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "var",
    "x",
    "int",
    new ValueNode(9, "5", "int"),
  );
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("var with type", () => {
  const input = `
var x: int
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(1, "var", "x", "int");
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test.run();
