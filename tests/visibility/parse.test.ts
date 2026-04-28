// @ts-nocheck
import { expect, test } from "vite-plus/test";

import DeclarationNode from "../../src/nodes/DeclarationNode.ts";
import FunctionNode from "../../src/nodes/FunctionNode.ts";
import ParameterNode from "../../src/nodes/ParameterNode.ts";
import StructNode from "../../src/nodes/StructNode.ts";
import TraitNode from "../../src/nodes/TraitNode.ts";
import Type from "../../src/nodes/Type.ts";
import ValueNode from "../../src/nodes/ValueNode.ts";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Visibility parse");

test("pub var", () => {
	const input = `
pub var x = 1
`;
	const parsed = parse(input);
	const expected = new DeclarationNode(
		1,
		"pub",
		"var",
		"x",
		new Type("int", true),
		new ValueNode(13, "1", new Type("int", true)),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("pub const", () => {
	const input = `
pub const x = 3
`;
	const parsed = parse(input);
	const expected = new DeclarationNode(
		1,
		"pub",
		"const",
		"x",
		new Type("int", true),
		new ValueNode(15, "3", new Type("int", true)),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("pub struct", () => {
	const input = `
pub struct Person {}
`;
	const parsed = parse(input);

	const expected = new StructNode(
		1,
		"pub",
		"Person",
		[],
		[],
		[new FunctionNode(-1, "pub", "init", new Type("Person"), [])],
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("pub trait", () => {
	const input = `
pub trait Person {}
`;
	const parsed = parse(input);
	const expected = new TraitNode(1, "pub", "Person");
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("pub function", () => {
	const input = `
pub func add() {}
`;
	const parsed = parse(input);
	const expected = new FunctionNode(1, "pub", "add", new Type(""), [], []);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("pub fields in struct", () => {
	const input = `
pub struct Person {
  pub var name: string
  private func greet() {}
}
`;
	const parsed = parse(input);
	const expected = new StructNode(
		1,
		"pub",
		"Person",
		[],
		[new DeclarationNode(23, "pub", "var", "name", new Type("string"))],
		[
			new FunctionNode(-1, "pub", "init", new Type("Person"), [
				new ParameterNode(-1, "name", new Type("string")),
			]),
			new FunctionNode(46, "private", "greet", new Type(""), [], []),
		],
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private var", () => {
	const input = `
private var x = 1
`;
	const parsed = parse(input);
	const expected = new DeclarationNode(
		1,
		"private",
		"var",
		"x",
		new Type("int", true),
		new ValueNode(19, "1", new Type("int", true)),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private const", () => {
	const input = `
private const x = 3
`;
	const parsed = parse(input);
	const expected = new DeclarationNode(
		1,
		"private",
		"const",
		"x",
		new Type("int", true),
		new ValueNode(15, "3", new Type("int", true)),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private struct", () => {
	const input = `
private struct Person {}
`;
	const parsed = parse(input);
	const expected = new StructNode(
		1,
		"private",
		"Person",
		[],
		[],
		[new FunctionNode(-1, "private", "init", new Type("Person"), [])],
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private trait", () => {
	const input = `
private trait Person {}
`;
	const parsed = parse(input);
	const expected = new TraitNode(1, "private", "Person");
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private function", () => {
	const input = `
private func add() {}
`;
	const parsed = parse(input);
	const expected = new FunctionNode(1, "private", "add", new Type(""), [], []);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private fields in struct", () => {
	const input = `
pub struct Person {
  private var name: string
  private func greet() {}
}
`;
	const parsed = parse(input);
	const expected = new StructNode(
		1,
		"pub",
		"Person",
		[],
		[new DeclarationNode(23, "private", "var", "name", new Type("string"))],
		[
			new FunctionNode(-1, "pub", "init", new Type("Person"), []),
			new FunctionNode(46, "private", "greet", new Type(""), [], []),
		],
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("private fields within scope", () => {
	const input = `
struct Person {
  private var name: string
  private func greet(self) -> string {
    return self.name
  }
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("private function within scope", () => {
	const input = `
struct Person {
  private func name() -> string {
    return "John"
  }
  private func greet(self) -> string {
    return self.name()
  }
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});
