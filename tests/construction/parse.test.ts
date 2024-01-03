import { suite } from "uvu";
import assert from "uvu/assert";
import AccessInvocationNode from "../../src/nodes/AccessInvocationNode";
import AccessNode from "../../src/nodes/AccessNode";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

const test = suite("Construction parse");

test("init struct", () => {
  const input = `
struct Person {
}
var x = Person.init()
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    19,
    "def",
    "var",
    "x",
    "Person",
    new AccessNode(
      27,
      new ValueNode(27, "Person", "Person"),
      new AccessInvocationNode(34, "init", [], "Person", true),
    ),
  );
  assert.equal(parsed.errors, []);
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[1]), trim_test_data(expected));
});

test("init struct with params", () => {
  const input = `
struct Person {
  var name: string
}
var x = Person.init("Andrew")
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    38,
    "def",
    "var",
    "x",
    "Person",
    new AccessNode(
      46,
      new ValueNode(46, "Person", "Person"),
      new AccessInvocationNode(
        53,
        "init",
        [new ValueNode(58, '"Andrew"', "string")],
        "Person",
        true,
      ),
    ),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[1]), trim_test_data(expected));
});

test("init struct with default values", () => {
  const input = `
struct Person {
  var name = "?"
}
var x = Person.init()
`;
  const parsed = parse(input);
  const expected = new DeclarationNode(
    36,
    "def",
    "var",
    "x",
    "Person",
    new AccessNode(
      44,
      new ValueNode(44, "Person", "Person"),
      new AccessInvocationNode(51, "init", [], "Person", true),
    ),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[1]), trim_test_data(expected));
});

test.run();
