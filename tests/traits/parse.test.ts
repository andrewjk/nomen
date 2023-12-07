import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";
import type ReturnNode from "../../src/types/ReturnNode";
import type RootNode from "../../src/types/RootNode";
import type StructNode from "../../src/types/StructNode";
import type SyntaxNode from "../../src/types/SyntaxNode";
import type TraitNode from "../../src/types/TraitNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Trait parse");

test("trait", () => {
  const input = `
trait Person {}

struct Frank: Person {}
`;
  const parsed = parse(input);
  const trait: TraitNode = {
    node_type: "trait",
    name: "Person",
    fields: [],
    functions: [],
    start: 0,
  };
  const struct: StructNode = {
    node_type: "struct",
    name: "Frank",
    traits: ["Person"],
    fields: [],
    functions: [
      {
        node_type: "func",
        name: "init",
        params: [],
        return_type: "Frank",
        statements: [],
        start: 0,
      },
    ],
    start: 0,
  };
  const expected: RootNode = {
    node_type: "root",
    statements: [trait, struct],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root), trim_test_data(expected));
});

test("trait after struct", () => {
  const input = `
struct Frank: Person {}

trait Person {}
`;
  const parsed = parse(input);
  const trait: TraitNode = {
    node_type: "trait",
    name: "Person",
    fields: [],
    functions: [],
    start: 0,
  };
  const struct: StructNode = {
    node_type: "struct",
    name: "Frank",
    traits: ["Person"],
    fields: [],
    functions: [
      {
        node_type: "func",
        name: "init",
        params: [],
        return_type: "Frank",
        statements: [],
        start: 0,
      },
    ],
    start: 0,
  };
  const expected: RootNode = {
    node_type: "root",
    statements: [struct, trait],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root), trim_test_data(expected));
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
  const parsed = parse(input);
  const trait: TraitNode = {
    node_type: "trait",
    name: "Person",
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
    functions: [],
    start: 0,
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
          start: 0,
        } as ValueNode,
        type: "string",
        start: 0,
      },
    ],
    functions: [
      {
        node_type: "func",
        name: "init",
        params: [],
        return_type: "Frank",
        statements: [],
        start: 0,
      },
    ],
    start: 0,
  };
  const expected: RootNode = {
    node_type: "root",
    statements: [trait, struct],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root), trim_test_data(expected));
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
  const parsed = parse(input);
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
        statements: [],
        start: 0,
      },
    ],
    start: 0,
  };
  const struct: StructNode = {
    node_type: "struct",
    name: "Frank",
    traits: ["Person"],
    fields: [],
    functions: [
      {
        node_type: "func",
        name: "init",
        params: [],
        return_type: "Frank",
        statements: [],
        start: 0,
      },
      {
        node_type: "func",
        name: "greet",
        params: [],
        return_type: "string",
        has_body: true,
        has_return: true,
        statements: [
          {
            node_type: "ret",
            value: {
              node_type: "value",
              value: '"hi"',
              type: "string",
              start: 0,
            } as ValueNode,
            type: "string",
            start: 0,
          } as ReturnNode,
        ],
        start: 0,
      },
    ],
    start: 0,
  };
  const expected: RootNode = {
    node_type: "root",
    statements: [trait, struct],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root), trim_test_data(expected));
});

test("trait with implemented functions", () => {
  const input = `
trait Person {
  func greet() -> string {
    return "hi"
  }
}

struct Frank: Person {}
`;
  const parsed = parse(input);
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
        has_body: true,
        has_return: true,
        statements: [
          {
            node_type: "ret",
            value: {
              node_type: "value",
              value: '"hi"',
              type: "string",
              start: 0,
            } as ValueNode,
            type: "string",
            start: 0,
          } as ReturnNode,
        ],
        start: 0,
      },
    ],
    start: 0,
  };
  const struct: StructNode = {
    node_type: "struct",
    name: "Frank",
    traits: ["Person"],
    fields: [],
    functions: [
      {
        node_type: "func",
        name: "init",
        params: [],
        return_type: "Frank",
        statements: [],
        start: 0,
      },
    ],
    start: 0,
  };
  const expected: RootNode = {
    node_type: "root",
    statements: [trait, struct],
    start: 0,
  };
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root), trim_test_data(expected));
});

test.run();
