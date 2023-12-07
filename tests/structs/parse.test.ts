import { suite } from "uvu";
import assert from "uvu/assert";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type StructNode from "../../src/types/StructNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Struct parse");

test("struct", () => {
  const input = `
struct Person {}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
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
        children: [],
        i: 0,
      },
    ],
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[0]),
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
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
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
        children: [],
        i: 0,
      },
      {
        node_type: "decl",
        declaration: "var",
        name: "age",
        value: {
          node_type: "value",
          value: "0",
          type: "int",
          children: [],
          i: 0,
        } as ValueNode,
        type: "int",
        children: [],
        i: 0,
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
            children: [],
            i: 0,
          },
        ],
        return_type: "Person",
        children: [],
        i: 0,
      },
    ],
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[0]),
    trim_test_data(expected),
  );
});

test("struct with functions", () => {
  const input = `
struct Person {
  func greet() {}
}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
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
        children: [],
        i: 0,
      },
      {
        node_type: "func",
        name: "greet",
        params: [],
        return_type: "",
        has_body: true,
        children: [],
        i: 0,
      },
    ],
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[0]),
    trim_test_data(expected),
  );
});

test.run();
