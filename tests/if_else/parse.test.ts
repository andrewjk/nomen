import { suite } from "uvu";
import assert from "uvu/assert";
import AssignmentNode from "../../src/nodes/AssignmentNode";
import BranchNode from "../../src/nodes/BranchNode";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import IfElseNode from "../../src/nodes/IfElseNode";
import OperationNode from "../../src/nodes/OperationNode";
import ReturnNode from "../../src/nodes/ReturnNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

const test = suite("If/else parse");

test("if", () => {
  const input = `
var x = 10
if x > 5 {
  x = 15
}
`;
  const parsed = parse(input);
  const expected = new IfElseNode(
    12,
    new OperationNode(
      15,
      ">",
      new ValueNode(15, "x", "int"),
      new ValueNode(19, "5", "int"),
      "bool",
    ),
    new BranchNode(25, [
      new AssignmentNode(25, new ValueNode(25, "x", "int"), new ValueNode(29, "15", "int")),
    ]),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[1]), trim_test_data(expected));
});

test("if else", () => {
  const input = `
var x = 10
if x > 5 {
  x = 15
else {
  x = 20
}
`;
  const parsed = parse(input);
  const expected = new IfElseNode(
    12,
    new OperationNode(
      15,
      ">",
      new ValueNode(15, "x", "int"),
      new ValueNode(19, "5", "int"),
      "bool",
    ),
    new BranchNode(25, [
      new AssignmentNode(25, new ValueNode(25, "x", "int"), new ValueNode(29, "15", "int")),
    ]),
    new BranchNode(41, [
      new AssignmentNode(41, new ValueNode(41, "x", "int"), new ValueNode(45, "20", "int")),
    ]),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[1]), trim_test_data(expected));
});

test("declaration with if", () => {
  const input = `
const x = 10
const y = if x > 5 {
            return 50
          else {
            return 0
          }
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    14,
    "const",
    "y",
    "int",
    new IfElseNode(
      24,
      new OperationNode(
        27,
        ">",
        new ValueNode(27, "x", "int"),
        new ValueNode(31, "5", "int"),
        "bool",
      ),
      new BranchNode(47, [new ReturnNode(47, new ValueNode(54, "50", "int"), "int")]),
      new BranchNode(86, [new ReturnNode(86, new ValueNode(93, "0", "int"), "int")]),
      "int",
    ),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[1]), trim_test_data(expected));
});

test("declaration with short if", () => {
  const input = `
const x = 10
const y = if x > 5 => 50
          else => 0
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    14,
    "const",
    "y",
    "int",
    new IfElseNode(
      24,
      new OperationNode(
        27,
        ">",
        new ValueNode(27, "x", "int"),
        new ValueNode(31, "5", "int"),
        "bool",
      ),
      new BranchNode(33, [new ReturnNode(33, new ValueNode(36, "50", "int"), "int")]),
      new BranchNode(54, [new ReturnNode(54, new ValueNode(57, "0", "int"), "int")]),
      "int",
    ),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[1]), trim_test_data(expected));
});

test("declaration with one line if", () => {
  const input = `
const x = 10
const y = if x > 5 => 50 else => 0
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    14,
    "const",
    "y",
    "int",
    new IfElseNode(
      24,
      new OperationNode(
        27,
        ">",
        new ValueNode(27, "x", "int"),
        new ValueNode(31, "5", "int"),
        "bool",
      ),
      new BranchNode(33, [new ReturnNode(33, new ValueNode(36, "50", "int"), "int")]),
      new BranchNode(44, [new ReturnNode(44, new ValueNode(47, "0", "int"), "int")]),
      "int",
    ),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[1]), trim_test_data(expected));
});

test.run();
