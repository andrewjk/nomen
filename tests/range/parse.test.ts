import { expect, test } from "vitest";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import RangeNode from "../../src/nodes/RangeNode";
import Type from "../../src/nodes/Type";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

//const test = suite("Range parse");

test("exclusive", () => {
  const input = `
var x = 1..2
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "mod",
    "var",
    "x",
    new Type("int", true),
    new RangeNode(9, new ValueNode(9, "1", "int"), new ValueNode(12, "2", "int"), false),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[0])).toEqual(trim_test_data(expected));
});

test("inclusive", () => {
  const input = `
var x = 1.=2
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "mod",
    "var",
    "x",
    new Type("int", true),
    new RangeNode(9, new ValueNode(9, "1", "int"), new ValueNode(12, "2", "int"), true),
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root.statements[0])).toEqual(trim_test_data(expected));
});
