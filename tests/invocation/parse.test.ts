import { expect, test } from "vitest";
import InvocationNode from "../../src/nodes/InvocationNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Invocation parse");

test("function without params", () => {
  const input = `
func greet() {}
greet()
`;
  const parsed = parse(input);
  const expected = new InvocationNode(17, "greet");
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("function with params", () => {
  const input = `
func greet(name: string, position: string) {}
greet("Andrew", "Manager")
`;
  const parsed = parse(input);
  const expected = new InvocationNode(47, "greet", "", [
    new ValueNode(53, '"Andrew"', "string"),
    new ValueNode(63, '"Manager"', "string"),
  ]);
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});
