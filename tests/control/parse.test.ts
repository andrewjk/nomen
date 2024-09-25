import { expect, test } from "vitest";
import BreakNode from "../../src/nodes/BreakNode";
import ContinueNode from "../../src/nodes/ContinueNode";
import ForLoopNode from "../../src/nodes/ForLoopNode";
import FunctionNode from "../../src/nodes/FunctionNode";
import PanicNode from "../../src/nodes/PanicNode";
import RangeNode from "../../src/nodes/RangeNode";
import TodoNode from "../../src/nodes/TodoNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Control parse");

test("break", () => {
  const input = `
for x in 0..5 {
  break
}
`;
  const parsed = parse(input);
  const expected = new ForLoopNode(
    1,
    new ValueNode(5, "x", "int"),
    new RangeNode(10, new ValueNode(10, "0", "int"), new ValueNode(13, "5", "int"), false),
    [new BreakNode(19)],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("continue", () => {
  const input = `
for x in 0..5 {
  continue
}
`;
  const parsed = parse(input);
  const expected = new ForLoopNode(
    1,
    new ValueNode(5, "x", "int"),
    new RangeNode(10, new ValueNode(10, "0", "int"), new ValueNode(13, "5", "int"), false),
    [new ContinueNode(19)],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("panic", () => {
  const input = `
func add() -> int {
  panic "something went wrong"
}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(
    1,
    "mod",
    "add",
    "int",
    [],
    [new PanicNode(23, "something went wrong")],
  );
  expected.has_return = true;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("todo", () => {
  const input = `
func add() -> int {
  todo "haven't done this yet"
}
`;
  const parsed = parse(input);
  const expected = new FunctionNode(
    1,
    "mod",
    "add",
    "int",
    [],
    [new TodoNode(23, "haven't done this yet")],
  );
  expected.has_return = true;
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});
