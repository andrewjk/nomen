import { expect, test } from "vitest";
import AccessFieldNode from "../../src/nodes/AccessFieldNode";
import AccessNode from "../../src/nodes/AccessNode";
import AssignmentNode from "../../src/nodes/AssignmentNode";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import FunctionNode from "../../src/nodes/FunctionNode";
import OperationNode from "../../src/nodes/OperationNode";
import ParameterNode from "../../src/nodes/ParameterNode";
import StructNode from "../../src/nodes/StructNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Struct parse");

test("struct", () => {
  const input = `
struct Person {}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    1,
    "mod",
    "Person",
    [],
    [],
    [new FunctionNode(-1, "mod", "init", "Person", [])],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("struct with fields", () => {
  const input = `
struct Person {
  var name: string
  var age = 0
}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    1,
    "mod",
    "Person",
    [],
    [
      new DeclarationNode(19, "mod", "var", "name", "string"),
      new DeclarationNode(38, "mod", "var", "age", "int", new ValueNode(48, "0", "int")),
    ],
    [new FunctionNode(-1, "mod", "init", "Person", [new ParameterNode(-1, "name", "string")])],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("struct with functions", () => {
  const input = `
struct Person {
  func greet() {}
}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    1,
    "mod",
    "Person",
    [],
    [],
    [
      new FunctionNode(-1, "mod", "init", "Person", []),
      new FunctionNode(19, "mod", "greet", "", [], []),
    ],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("struct with mutating functions", () => {
  const input = `
struct Person {
  var age = 0
  func grow(self) {
    self.age = self.age + 1
  }
}
`;
  const parsed = parse(input);
  const expected = new StructNode(
    0,
    "mod",
    "Person",
    [],
    [new DeclarationNode(0, "mod", "var", "age", "int", new ValueNode(0, "0", "int"))],
    [
      new FunctionNode(-1, "mod", "init", "Person", []),
      new FunctionNode(
        0,
        "mod",
        "grow",
        "",
        [new ParameterNode(0, "self", "Person", undefined, true)],
        [
          new AssignmentNode(
            0,
            new AccessNode(
              0,
              new ValueNode(0, "self", "Person"),
              new AccessFieldNode(0, "age", "int"),
            ),
            new OperationNode(
              0,
              "+",
              new AccessNode(
                0,
                new ValueNode(0, "self", "Person"),
                new AccessFieldNode(0, "age", "int"),
              ),
              new ValueNode(0, "1", "int"),
              "int",
            ),
          ),
        ],
      ),
    ],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});
