import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type ParseNode from "../../src/types/ParseNode";
import type ReturnNode from "../../src/types/ReturnNode";
import type StructNode from "../../src/types/StructNode";
import type TraitNode from "../../src/types/TraitNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Trait parse");

test("trait", () => {
  const input = `
trait Person {}

struct Frank: Person {}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const trait: TraitNode = {
    node_type: "trait",
    name: "Person",
    fields: [],
    functions: [],
    children: [],
    i: 0,
  };
  const struct: StructNode = {
    node_type: "struct",
    name: "Frank",
    traits: ["Person"],
    fields: [],
    functions: [],
    children: [],
    i: 0,
  };
  const expected: ParseNode = {
    node_type: "root",
    children: [trait, struct],
    i: 0,
  };
  assert.equal(trim_test_data(result.root), trim_test_data(expected));
});

test("trait with fields", () => {
  const input = `
trait Person {
  var name: string
  var age = 0
}

struct Frank: Person {
  var name = "Frank"
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const trait: TraitNode = {
    node_type: "trait",
    name: "Person",
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
    functions: [],
    children: [],
    i: 0,
  };
  const struct: StructNode = {
    node_type: "struct",
    name: "Frank",
    traits: ["Person"],
    fields: [
      {
        node_type: "decl",
        declaration: "var",
        name: "name",
        value: {
          node_type: "value",
          value: '"Frank"',
          type: "string",
          children: [],
          i: 0,
        } as ValueNode,
        type: "string",
        children: [],
        i: 0,
      },
    ],
    functions: [],
    children: [],
    i: 0,
  };
  const expected: ParseNode = {
    node_type: "root",
    children: [trait, struct],
    i: 0,
  };
  assert.equal(trim_test_data(result.root), trim_test_data(expected));
});

test("trait with functions", () => {
  const input = `
trait Person {
  func greet() -> string
}

struct Frank: Person {
  func greet() -> string {
    return "hi"
  }
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const trait: TraitNode = {
    node_type: "trait",
    name: "Person",
    fields: [],
    functions: [
      {
        node_type: "func",
        name: "greet",
        params: [],
        return_type: "string",
        has_return: false,
        children: [],
        i: 0,
      },
    ],
    children: [],
    i: 0,
  };
  const struct: StructNode = {
    node_type: "struct",
    name: "Frank",
    traits: ["Person"],
    fields: [],
    functions: [
      {
        node_type: "func",
        name: "greet",
        params: [],
        return_type: "string",
        has_return: true,
        children: [
          {
            node_type: "ret",
            value: '"hi"',
            type: "string",
            children: [],
            i: 0,
          } as ReturnNode,
        ],
        i: 0,
      },
    ],
    children: [],
    i: 0,
  };
  const expected: ParseNode = {
    node_type: "root",
    children: [trait, struct],
    i: 0,
  };
  assert.equal(trim_test_data(result.root), trim_test_data(expected));
});

test("trait with implemented functions", () => {
  const input = `
trait Person {
  func greet() {}
}

struct Frank: Person {
  func greet() -> string {
    return "hi"
  }
}
`;
  const tokens = tokenize(input);
  const result = parse(tokens);
  const trait: TraitNode = {
    node_type: "trait",
    name: "Person",
    fields: [],
    functions: [
      {
        node_type: "func",
        name: "greet",
        params: [],
        return_type: "",
        has_return: false,
        children: [],
        i: 0,
      },
    ],
    children: [],
    i: 0,
  };
  const struct: StructNode = {
    node_type: "struct",
    name: "Frank",
    traits: ["Person"],
    fields: [],
    functions: [
      {
        node_type: "func",
        name: "greet",
        params: [],
        return_type: "string",
        has_return: true,
        children: [
          {
            node_type: "ret",
            value: '"hi"',
            type: "string",
            children: [],
            i: 0,
          } as ReturnNode,
        ],
        i: 0,
      },
    ],
    children: [],
    i: 0,
  };
  const expected: ParseNode = {
    node_type: "root",
    children: [trait, struct],
    i: 0,
  };
  assert.equal(trim_test_data(result.root), trim_test_data(expected));
});

test.run();
