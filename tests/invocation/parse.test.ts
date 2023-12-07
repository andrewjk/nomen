import { suite } from "uvu";
import assert from "uvu/assert";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type InvocationNode from "../../src/types/InvocationNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Invocation parse");

test("function without params", () => {
  const input = `
func greet() {}
greet()
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const expected: InvocationNode = {
    node_type: "invoke",
    name: "greet",
    params: [],
    type: "",
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[1]),
    trim_test_data(expected),
  );
});

test("function with params", () => {
  const input = `
func greet(name: string, position: string) {}
greet("Andrew", "Manager")
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const expected: InvocationNode = {
    node_type: "invoke",
    name: "greet",
    params: [
      {
        node_type: "value",
        value: '"Andrew"',
        type: "string",
        children: [],
        i: 0,
      } as ValueNode,
      {
        node_type: "value",
        value: '"Manager"',
        type: "string",
        children: [],
        i: 0,
      } as ValueNode,
    ],
    type: "",
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[1]),
    trim_test_data(expected),
  );
});

test.run();
