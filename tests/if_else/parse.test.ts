import { expect, test } from "vitest";
import AssignmentNode from "../../src/nodes/AssignmentNode";
import BranchNode from "../../src/nodes/BranchNode";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import IfElseNode from "../../src/nodes/IfElseNode";
import OperationNode from "../../src/nodes/OperationNode";
import ReturnNode from "../../src/nodes/ReturnNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

//const test = suite("If/else parse");

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
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[1])).toEqual(trim_test_data(expected));
});

test("if else", () => {
  const input = `
var x = 10
if x > 5 {
  x = 15
} else {
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
    new BranchNode(43, [
      new AssignmentNode(43, new ValueNode(43, "x", "int"), new ValueNode(47, "20", "int")),
    ]),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[1])).toEqual(trim_test_data(expected));
});

test("declaration with if", () => {
  const input = `
const x = 10
const y = if x > 5 {
  return 50
} else {
  return 0
}
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    14,
    "mod",
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
      new BranchNode(37, [new ReturnNode(37, new ValueNode(44, "50", "int"), "int")]),
      new BranchNode(58, [new ReturnNode(58, new ValueNode(65, "0", "int"), "int")]),
      "int",
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[1])).toEqual(trim_test_data(expected));
});

test("declaration with short if", () => {
  const input = `
const x = 10
const y = if x > 5 ~ 50
          else ~ 0
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    14,
    "mod",
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
      new BranchNode(33, [new ReturnNode(33, new ValueNode(35, "50", "int"), "int")]),
      new BranchNode(53, [new ReturnNode(53, new ValueNode(55, "0", "int"), "int")]),
      "int",
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[1])).toEqual(trim_test_data(expected));
});

test("declaration with one line if", () => {
  const input = `
const x = 10
const y = if x > 5 ~ 50 else ~ 0
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    14,
    "mod",
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
      new BranchNode(33, [new ReturnNode(33, new ValueNode(35, "50", "int"), "int")]),
      new BranchNode(43, [new ReturnNode(43, new ValueNode(45, "0", "int"), "int")]),
      "int",
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[1])).toEqual(trim_test_data(expected));
});
