import { expect, test } from "vitest";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import OperationNode from "../../src/nodes/OperationNode";
import Type from "../../src/nodes/Type";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

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
    new Type("int", true),
    new OperationNode(
      9,
      "+",
      new ValueNode(9, "1", new Type("int", true)),
      new ValueNode(13, "2", new Type("int", true)),
      new Type("int", true),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
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
    new Type("int", true),
    new OperationNode(
      9,
      "-",
      new ValueNode(9, "1", new Type("int", true)),
      new ValueNode(13, "2", new Type("int", true)),
      new Type("int", true),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
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
    new Type("int", true),
    new OperationNode(
      9,
      "+",
      new ValueNode(9, "1", new Type("int", true)),
      new OperationNode(
        13,
        "-",
        new ValueNode(13, "2", new Type("int", true)),
        new ValueNode(17, "3", new Type("int", true)),
        new Type("int", true),
      ),
      new Type("int", true),
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});
