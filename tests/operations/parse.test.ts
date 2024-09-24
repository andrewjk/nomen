import { expect, test } from "vitest";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import OperationNode from "../../src/nodes/OperationNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

//const test = suite("Operation parse");

test("addition", () => {
  const input = `
var x = 1 + 2
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "mod",
    "var",
    "x",
    "int",
    new OperationNode(9, "+", new ValueNode(9, "1", "int"), new ValueNode(13, "2", "int"), "int"),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[0])).toEqual(trim_test_data(expected));
});

test("subtraction", () => {
  const input = `
var x = 1 - 2
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "mod",
    "var",
    "x",
    "int",
    new OperationNode(9, "-", new ValueNode(9, "1", "int"), new ValueNode(13, "2", "int"), "int"),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[0])).toEqual(trim_test_data(expected));
});

test("series", () => {
  const input = `
var x = 1 + 2 - 3
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "mod",
    "var",
    "x",
    "int",
    new OperationNode(
      9,
      "+",
      new ValueNode(9, "1", "int"),
      new OperationNode(
        13,
        "-",
        new ValueNode(13, "2", "int"),
        new ValueNode(17, "3", "int"),
        "int",
      ),
      "int",
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[0])).toEqual(trim_test_data(expected));
});
