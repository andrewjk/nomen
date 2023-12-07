import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type StructNode from "../../src/types/StructNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Struct parse");

test("struct", () => {
  const input = `
struct Person {}
`;
  const parsed = parse(input);
  const expected: StructNode = {
    node_type: "struct",
    name: "Person",
    traits: [],
    fields: [],
    functions: [
      {
        node_type: "func",
        name: "init",
        params: [],
        return_type: "Person",
        statements: [],
        start: 0,
      },
    ],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("struct with fields", () => {
  const input = `
struct Person {
  var name: string
  var age = 0
}
`;
  const parsed = parse(input);
  const expected: StructNode = {
    node_type: "struct",
    name: "Person",
    traits: [],
    fields: [
      {
        node_type: "decl",
        declaration: "var",
        name: "name",
        type: "string",
        start: 0,
      },
      {
        node_type: "decl",
        declaration: "var",
        name: "age",
        value: {
          node_type: "value",
          value: "0",
          type: "int",
          start: 0,
        } as ValueNode,
        type: "int",
        start: 0,
      },
    ],
    functions: [
      {
        node_type: "func",
        name: "init",
        params: [
          {
            node_type: "param",
            name: "name",
            type: "string",
            default_value: undefined,
            start: 0,
          },
        ],
        return_type: "Person",
        statements: [],
        start: 0,
      },
    ],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test("struct with functions", () => {
  const input = `
struct Person {
  func greet() {}
}
`;
  const parsed = parse(input);
  const expected: StructNode = {
    node_type: "struct",
    name: "Person",
    traits: [],
    fields: [],
    functions: [
      {
        node_type: "func",
        name: "init",
        params: [],
        return_type: "Person",
        statements: [],
        start: 0,
      },
      {
        node_type: "func",
        name: "greet",
        params: [],
        return_type: "",
        has_body: true,
        statements: [],
        start: 0,
      },
    ],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(
    trim_test_data(parsed.root.statements[0]),
    trim_test_data(expected),
  );
});

test.run();
