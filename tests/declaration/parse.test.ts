import { suite } from "uvu";
import assert from "uvu/assert";
import parse from "../../src/parse";

const test = suite("Declaration parse");

test("const with value", () => {
  const input = `
const x = 5
`;
  const result = parse(input);
  const expected = {
    nodetype: "root",
    children: [
      {
        nodetype: "decl",
        declaration: "const",
        name: "x",
        value: "5",
        type: "int",
        children: [],
      },
    ],
  };
  assert.equal(result.root, expected);
});

test("const with type", () => {
  const input = `
const x: int
`;
  const result = parse(input);
  const expected = {
    nodetype: "root",
    children: [
      {
        nodetype: "decl",
        declaration: "const",
        name: "x",
        value: "",
        type: "int",
        children: [],
      },
    ],
  };
  assert.equal(result.root, expected);
});

test("let with value", () => {
  const input = `
let x = 5
`;
  const result = parse(input);
  const expected = {
    nodetype: "root",
    children: [
      {
        nodetype: "decl",
        declaration: "let",
        name: "x",
        value: "5",
        type: "int",
        children: [],
      },
    ],
  };
  assert.equal(result.root, expected);
});

test("let with type", () => {
  const input = `
let x: int
`;
  const result = parse(input);
  const expected = {
    nodetype: "root",
    children: [
      {
        nodetype: "decl",
        declaration: "let",
        name: "x",
        value: "",
        type: "int",
        children: [],
      },
    ],
  };
  assert.equal(result.root, expected);
});

test.run();
