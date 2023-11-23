import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type StructNode from "../../src/types/StructNode";

const test = suite("Struct parse");

test("struct", () => {
  const input = `
struct Person {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: StructNode = {
    node_type: "struct",
    name: "Person",
    traits: [],
    fields: [],
    functions: [],
    children: [],
  };
  assert.equal(result.root.children[0], expected);
});

test("struct with fields", () => {
  const input = `
struct Person {
  var name: string
  var age = 0
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: StructNode = {
    node_type: "struct",
    name: "Person",
    traits: [],
    fields: [
      {
        node_type: "decl",
        declaration: "var",
        name: "name",
        value: "",
        type: "string",
        children: [],
      },
      {
        node_type: "decl",
        declaration: "var",
        name: "age",
        value: "0",
        type: "int",
        children: [],
      },
    ],
    functions: [],
    children: [],
  };
  assert.equal(result.root.children[0], expected);
});

test("struct with functions", () => {
  const input = `
struct Person {
  func greet() {}
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: StructNode = {
    node_type: "struct",
    name: "Person",
    traits: [],
    fields: [],
    functions: [
      {
        node_type: "func",
        name: "greet",
        params: [],
        return_type: "",
        has_return: false,
        children: [],
      },
    ],
    children: [],
  };
  assert.equal(result.root.children[0], expected);
});

test.run();
