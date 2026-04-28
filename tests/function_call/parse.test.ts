import { expect, test } from "vite-plus/test";

import FunctionCallNode from "../../src/nodes/FunctionCallNode.ts";
import Type from "../../src/nodes/Type.ts";
import ValueNode from "../../src/nodes/ValueNode.ts";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Function call parse");

test("function without params", () => {
  const input = `
func greet() {}
greet()
`;
  const parsed = parse(input);
  const expected = new FunctionCallNode(17, "greet", new Type(""), [], true);
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("function with params", () => {
  const input = `
func greet(name: string, position: string) {}
greet("Andrew", "Manager")
`;
  const parsed = parse(input);
  const expected = new FunctionCallNode(
    47,
    "greet",
    new Type(""),
    [
      new ValueNode(53, '"Andrew"', new Type("string", true)),
      new ValueNode(63, '"Manager"', new Type("string", true)),
    ],
    true,
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});
