import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type DeclarationNode from "../../src/types/DeclarationNode";

const test = suite("Declaration parse");

test("const with value", () => {
  const input = `
const x = 5
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "const",
    name: "x",
    value: "5",
    type: "int",
    children: [],
  };
  assert.equal(result.root.children[0], expected);
});

test("const with type", () => {
  const input = `
const x: int
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "const",
    name: "x",
    value: "",
    type: "int",
    children: [],
  };
  assert.equal(result.root.children[0], expected);
});

test("var with value", () => {
  const input = `
var x = 5
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: "5",
    type: "int",
    children: [],
  };
  assert.equal(result.root.children[0], expected);
});

test("var with type", () => {
  const input = `
var x: int
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: "",
    type: "int",
    children: [],
  };
  assert.equal(result.root.children[0], expected);
});

test.run();
