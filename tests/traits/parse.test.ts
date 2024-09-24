import { expect, test } from "vitest";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import FunctionNode from "../../src/nodes/FunctionNode";
import ReturnNode from "../../src/nodes/ReturnNode";
import RootNode from "../../src/nodes/RootNode";
import StructNode from "../../src/nodes/StructNode";
import TraitNode from "../../src/nodes/TraitNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_data from "../trim_test_data";

//const test = suite("Trait parse");

test("trait", () => {
  const input = `
trait Person {}

struct Frank: Person {}
`;
  const parsed = parse(input);
  const expected = new RootNode([
    new TraitNode(1, "mod", "Person"),
    new StructNode(
      18,
      "mod",
      "Frank",
      ["Person"],
      [],
      [new FunctionNode(-1, "mod", "init", "Frank")],
    ),
  ]);
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root)).toEqual(trim_test_data(expected));
});

test("trait after struct", () => {
  const input = `
struct Frank: Person {}

trait Person {}
`;
  const parsed = parse(input);
  const expected = new RootNode([
    new StructNode(
      1,
      "mod",
      "Frank",
      ["Person"],
      [],
      [new FunctionNode(-1, "mod", "init", "Frank")],
    ),
    new TraitNode(26, "mod", "Person"),
  ]);
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root)).toEqual(trim_test_data(expected));
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
  const expected = new RootNode([
    new TraitNode(1, "mod", "Person", [
      new DeclarationNode(18, "mod", "var", "name", "string"),
      new DeclarationNode(37, "mod", "var", "age", "int", new ValueNode(47, "0", "int")),
    ]),
    new StructNode(
      52,
      "mod",
      "Frank",
      ["Person"],
      [
        new DeclarationNode(
          77,
          "mod",
          "var",
          "name",
          "string",
          new ValueNode(88, '"Frank"', "string"),
        ),
      ],
      [new FunctionNode(-1, "mod", "init", "Frank")],
    ),
  ]);
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root)).toEqual(trim_test_data(expected));
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
  const expected = new RootNode([
    new TraitNode(1, "mod", "Person", [], [new FunctionNode(18, "mod", "greet", "string")]),
    new StructNode(
      44,
      "mod",
      "Frank",
      ["Person"],
      [],
      [
        new FunctionNode(-1, "mod", "init", "Frank"),
        new FunctionNode(
          69,
          "mod",
          "greet",
          "string",
          [],
          [new ReturnNode(98, new ValueNode(105, '"hi"', "string"), "string")],
        ),
      ],
    ),
  ]);
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root)).toEqual(trim_test_data(expected));
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
  const expected = new RootNode([
    new TraitNode(
      1,
      "mod",
      "Person",
      [],
      [
        new FunctionNode(
          18,
          "mod",
          "greet",
          "string",
          [],
          [new ReturnNode(47, new ValueNode(54, '"hi"', "string"), "string")],
        ),
      ],
    ),
    new StructNode(
      66,
      "mod",
      "Frank",
      ["Person"],
      [],
      [new FunctionNode(-1, "mod", "init", "Frank")],
    ),
  ]);
  expect(parsed.errors).toEqual([]);
  expect(trim_test_data(parsed.root)).toEqual(trim_test_data(expected));
});
