import { expect, test } from "vite-plus/test";

import AccessFieldNode from "../../src/nodes/AccessFieldNode.ts";
import AccessNode from "../../src/nodes/AccessNode.ts";
import AssignmentNode from "../../src/nodes/AssignmentNode.ts";
import DeclarationNode from "../../src/nodes/DeclarationNode.ts";
import FunctionNode from "../../src/nodes/FunctionNode.ts";
import OperationNode from "../../src/nodes/OperationNode.ts";
import ParameterNode from "../../src/nodes/ParameterNode.ts";
import StructNode from "../../src/nodes/StructNode.ts";
import Type from "../../src/nodes/Type.ts";
import ValueNode from "../../src/nodes/ValueNode.ts";
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
    [new FunctionNode(-1, "mod", "init", new Type("Person"), [])],
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
      new DeclarationNode(19, "mod", "var", "name", new Type("string")),
      new DeclarationNode(
        38,
        "mod",
        "var",
        "age",
        new Type("int", true),
        new ValueNode(48, "0", new Type("int", true)),
      ),
    ],
    [
      new FunctionNode(-1, "mod", "init", new Type("Person"), [
        new ParameterNode(-1, "name", new Type("string")),
      ]),
    ],
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
      new FunctionNode(-1, "mod", "init", new Type("Person"), []),
      new FunctionNode(19, "mod", "greet", new Type(""), [], []),
    ],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("struct with mutating functions", () => {
  const input = `
struct Person {
  var age = 0
  func grow(var self) {
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
    [
      new DeclarationNode(
        0,
        "mod",
        "var",
        "age",
        new Type("int", true),
        new ValueNode(0, "0", new Type("int", true)),
      ),
    ],
    [
      new FunctionNode(-1, "mod", "init", new Type("Person"), []),
      new FunctionNode(
        0,
        "mod",
        "grow",
        new Type(""),
        [new ParameterNode(0, "self", new Type("Person"), undefined, true, "var")],
        [
          new AssignmentNode(
            0,
            new AccessNode(
              0,
              new ValueNode(0, "self", new Type("Person")),
              new AccessFieldNode(0, "age", new Type("int", true)),
            ),
            new OperationNode(
              0,
              "+",
              new AccessNode(
                0,
                new ValueNode(0, "self", new Type("Person")),
                new AccessFieldNode(0, "age", new Type("int", true)),
              ),
              new ValueNode(0, "1", new Type("int", true)),
              new Type("int", true),
            ),
          ),
        ],
      ),
    ],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});
