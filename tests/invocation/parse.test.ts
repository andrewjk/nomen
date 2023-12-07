import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type InvocationNode from "../../src/types/InvocationNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Invocation parse");

test("function without params", () => {
  const input = `
func greet() {}
greet()
`;
  const parsed = parse(input);
  const expected: InvocationNode = {
    node_type: "invoke",
    name: "greet",
    params: [],
    type: "",
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[1]),
    trim_test_data(expected),
  );
});

test("function with params", () => {
  const input = `
func greet(name: string, position: string) {}
greet("Andrew", "Manager")
`;
  const parsed = parse(input);
  const expected: InvocationNode = {
    node_type: "invoke",
    name: "greet",
    params: [
      {
        node_type: "value",
        value: '"Andrew"',
        type: "string",
        start: 0,
      } as ValueNode,
      {
        node_type: "value",
        value: '"Manager"',
        type: "string",
        start: 0,
      } as ValueNode,
    ],
    type: "",
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[1]),
    trim_test_data(expected),
  );
});

test.run();
