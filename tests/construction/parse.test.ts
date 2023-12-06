import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type AccessInvocationNode from "../../src/types/AccessInvocationNode";
import type AccessNode from "../../src/types/AccessNode";
import type DeclarationNode from "../../src/types/DeclarationNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Construction parse");

test("init struct", () => {
  const input = `
struct Person {
}
var x = Person.init()
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "access",
      source: {
        node_type: "value",
        value: "Person",
        type: "Person",
      } as ValueNode,
      access: {
        node_type: "accinv",
        name: "init",
        params: [],
        type: "Person",
        static: true,
        children: [],
        i: 0,
      } as AccessInvocationNode,
      children: [],
      i: 0,
    } as AccessNode,
    type: "Person",
    children: [],
    i: 0,
  };
  assert.equal(result.errors, []);
  assert.equal(result.errors, []);
  assert.equal(
    trim_test_data(result.root.children[1]),
    trim_test_data(expected),
  );
});

test("init struct with params", () => {
  const input = `
struct Person {
  var name: string
}
var x = Person.init("Andrew")
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "access",
      source: {
        node_type: "value",
        value: "Person",
        type: "Person",
      } as ValueNode,
      access: {
        node_type: "accinv",
        name: "init",
        params: [
          {
            node_type: "value",
            value: '"Andrew"',
            type: "string",
            children: [],
            i: 0,
          } as ValueNode,
        ],
        type: "Person",
        static: true,
        children: [],
        i: 0,
      } as AccessInvocationNode,
      children: [],
      i: 0,
    } as AccessNode,
    type: "Person",
    children: [],
    i: 0,
  };
  assert.equal(result.errors, []);
  assert.equal(
    trim_test_data(result.root.children[1]),
    trim_test_data(expected),
  );
});

test("init struct with default values", () => {
  const input = `
struct Person {
  var name = "?"
}
var x = Person.init()
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "access",
      source: {
        node_type: "value",
        value: "Person",
        type: "Person",
      } as ValueNode,
      access: {
        node_type: "accinv",
        name: "init",
        params: [],
        type: "Person",
        static: true,
        children: [],
        i: 0,
      } as AccessInvocationNode,
      children: [],
      i: 0,
    } as AccessNode,
    type: "Person",
    children: [],
    i: 0,
  };
  assert.equal(result.errors, []);
  assert.equal(
    trim_test_data(result.root.children[1]),
    trim_test_data(expected),
  );
});

test.run();
