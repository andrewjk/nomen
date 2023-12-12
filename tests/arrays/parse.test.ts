import { suite } from "uvu";
import assert from "uvu/assert";
import ArrayValuesNode from "../../src/nodes/ArrayValuesNode";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

const test = suite("Array parse");

test("declaration with type", () => {
  const input = `
const x: int[]
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(1, "const", "x", "int[]");
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("declaration with value", () => {
  const input = `
var x = [1, 2, 3]
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    1,
    "var",
    "x",
    "int[3]",
    new ArrayValuesNode(
      9,
      [
        new ValueNode(10, "1", "int"),
        new ValueNode(13, "2", "int"),
        new ValueNode(16, "3", "int"),
      ],
      "int[3]",
    ),
  );
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test.run();
