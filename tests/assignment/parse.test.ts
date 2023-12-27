import { suite } from "uvu";
import assert from "uvu/assert";
import AccessInvocationNode from "../../src/nodes/AccessInvocationNode";
import AccessNode from "../../src/nodes/AccessNode";
import AssignmentNode from "../../src/nodes/AssignmentNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

const test = suite("Assignment parse");

test("assignment to var", () => {
  const input = `
var x: int
x = 5
`;
  const parsed = parse(input);
  const expected = new AssignmentNode(
    12,
    new ValueNode(12, "x", "int"),
    new ValueNode(16, "5", "int"),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[1]), trim_test_data(expected));
});

test("trait assignment with struct", () => {
  const input = `
trait Animal {}
struct Dog: Animal {}
var x: Animal
x = Dog.init()
`;
  const parsed = parse(input);
  const expected = new AssignmentNode(
    53,
    new ValueNode(53, "x", "Animal"),
    new AccessNode(
      57,
      new ValueNode(57, "Dog", "Dog"),
      new AccessInvocationNode(61, "init", [], "Dog", true),
    ),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[3]), trim_test_data(expected));
});

test.run();
