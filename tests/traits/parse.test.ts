import { expect, test } from "vitest";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import FunctionNode from "../../src/nodes/FunctionNode";
import ReturnNode from "../../src/nodes/ReturnNode";
import RootNode from "../../src/nodes/RootNode";
import StructNode from "../../src/nodes/StructNode";
import TraitNode from "../../src/nodes/TraitNode";
import Type from "../../src/nodes/Type";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Trait parse");

test("trait", () => {
  const input = `
trait Person {}

struct Frank: Person {}
`;
  const parsed = parse(input);
  const expected = new RootNode(
    [],
    [
      new TraitNode(1, "mod", "Person"),
      new StructNode(
        18,
        "mod",
        "Frank",
        ["Person"],
        [],
        [new FunctionNode(-1, "mod", "init", new Type("Frank"))],
      ),
    ],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root)).toEqual(trim_test_parse(expected));
});

test("trait after struct", () => {
  const input = `
struct Frank: Person {}

trait Person {}
`;
  const parsed = parse(input);
  const expected = new RootNode(
    [],
    [
      new StructNode(
        1,
        "mod",
        "Frank",
        ["Person"],
        [],
        [new FunctionNode(-1, "mod", "init", new Type("Frank"))],
      ),
      new TraitNode(26, "mod", "Person"),
    ],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root)).toEqual(trim_test_parse(expected));
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
  const expected = new RootNode(
    [],
    [
      new TraitNode(1, "mod", "Person", [
        new DeclarationNode(18, "mod", "var", "name", new Type("string")),
        new DeclarationNode(
          37,
          "mod",
          "var",
          "age",
          new Type("int", true),
          new ValueNode(47, "0", new Type("int", true)),
        ),
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
            new Type("string", true),
            new ValueNode(88, '"Frank"', new Type("string", true)),
          ),
        ],
        [new FunctionNode(-1, "mod", "init", new Type("Frank"))],
      ),
    ],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root)).toEqual(trim_test_parse(expected));
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
  const expected = new RootNode(
    [],
    [
      new TraitNode(
        1,
        "mod",
        "Person",
        [],
        [new FunctionNode(18, "mod", "greet", new Type("string"))],
      ),
      new StructNode(
        44,
        "mod",
        "Frank",
        ["Person"],
        [],
        [
          new FunctionNode(-1, "mod", "init", new Type("Frank")),
          new FunctionNode(
            69,
            "mod",
            "greet",
            new Type("string", true),
            [],
            [
              new ReturnNode(
                98,
                new ValueNode(105, '"hi"', new Type("string", true)),
                new Type("string", true),
              ),
            ],
          ),
        ],
      ),
    ],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root)).toEqual(trim_test_parse(expected));
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
  const expected = new RootNode(
    [],
    [
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
            new Type("string", true),
            [],
            [
              new ReturnNode(
                47,
                new ValueNode(54, '"hi"', new Type("string", true)),
                new Type("string", true),
              ),
            ],
          ),
        ],
      ),
      new StructNode(
        66,
        "mod",
        "Frank",
        ["Person"],
        [],
        [new FunctionNode(-1, "mod", "init", new Type("Frank"))],
      ),
    ],
  );
  expect(parsed.errors).toEqual([]);
  expect(trim_test_parse(parsed.root)).toEqual(trim_test_parse(expected));
});
