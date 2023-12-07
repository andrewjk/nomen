import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type ForNode from "../../src/types/ForNode";
import type RangeNode from "../../src/types/RangeNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("For parse");

test("with array", () => {
  const input = `
const y = [1, 2, 3]
for x in y {
  // ...
}
`;
  const parsed = parse(input);
  const expected: ForNode = {
    node_type: "for",
    item: {
      node_type: "value",
      value: "x",
      type: "int",
      children: [],
      i: 0,
    } as ValueNode,
    list: {
      node_type: "value",
      value: "y",
      type: "int[3]",
      children: [],
      i: 0,
    } as ValueNode,
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.children[1]),
    trim_test_data(expected),
  );
});

test("with range", () => {
  const input = `
for x in 0..5 {}
`;
  const parsed = parse(input);
  const expected: ForNode = {
    node_type: "for",
    item: {
      node_type: "value",
      value: "x",
      type: "int",
      children: [],
      i: 0,
    } as ValueNode,
    list: {
      node_type: "range",
      left_value: {
        node_type: "value",
        value: "0",
        type: "int",
        children: [],
        i: 0,
      } as ValueNode,
      right_value: {
        node_type: "value",
        value: "5",
        type: "int",
        children: [],
        i: 0,
      } as ValueNode,
      inclusive: false,
      children: [],
      i: 0,
    } as RangeNode,
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.children[0]),
    trim_test_data(expected),
  );
});

test.run();
