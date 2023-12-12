import { suite } from "uvu";
import assert from "uvu/assert";
import InvocationNode from "../../src/nodes/InvocationNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

const test = suite("Invocation parse");

test("function without params", () => {
  const input = `
func greet() {}
greet()
`;
  const parsed = parse(input);
  const expected = new InvocationNode(17, "greet");
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[1]), trim_test_data(expected));
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
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[1]), trim_test_data(expected));
});

test.run();
