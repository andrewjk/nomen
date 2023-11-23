import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type ParseNode from "../../src/types/ParseNode";
import ReturnNode from "../../src/types/ReturnNode";
import type StructNode from "../../src/types/StructNode";
import type TraitNode from "../../src/types/TraitNode";

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
  };
  const struct: StructNode = {
    node_type: "struct",
    name: "Frank",
    traits: ["Person"],
    fields: [],
    functions: [],
    children: [],
  };
  const expected: ParseNode = {
    node_type: "root",
    children: [trait, struct],
  };
  assert.equal(result.root, expected);
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
  const struct: StructNode = {
    node_type: "struct",
    name: "Frank",
    traits: ["Person"],
    fields: [
      {
        node_type: "decl",
        declaration: "var",
        name: "name",
        value: '"Frank"',
        type: "string",
        children: [],
      },
    ],
    functions: [],
    children: [],
  };
  const expected: ParseNode = {
    node_type: "root",
    children: [trait, struct],
  };
  assert.equal(result.root, expected);
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
      },
    ],
    children: [],
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
          } as ReturnNode,
        ],
      },
    ],
    children: [],
  };
  const expected: ParseNode = {
    node_type: "root",
    children: [trait, struct],
  };
  assert.equal(result.root, expected);
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
      },
    ],
    children: [],
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
          } as ReturnNode,
        ],
      },
    ],
    children: [],
  };
  const expected: ParseNode = {
    node_type: "root",
    children: [trait, struct],
  };
  assert.equal(result.root, expected);
});

test.run();
