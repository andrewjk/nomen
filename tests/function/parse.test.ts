import { expect, test } from "vite-plus/test";

import DeclarationNode from "../../src/nodes/DeclarationNode.ts";
import FunctionNode from "../../src/nodes/FunctionNode.ts";
import ParameterNode from "../../src/nodes/ParameterNode.ts";
import ReturnNode from "../../src/nodes/ReturnNode.ts";
import RootNode from "../../src/nodes/RootNode.ts";
import Type from "../../src/nodes/Type.ts";
import ValueNode from "../../src/nodes/ValueNode.ts";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Function parse");

test("function", () => {
	const input = `
func add() {}
`;
	const parsed = parse(input);
	const expected = new FunctionNode(1, "mod", "add", new Type(""), [], []);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("function with params", () => {
	const input = `
func add(a: int, b: int) {}
`;
	const parsed = parse(input);
	const expected = new FunctionNode(
		1,
		"mod",
		"add",
		new Type(""),
		[new ParameterNode(10, "a", new Type("int")), new ParameterNode(18, "b", new Type("int"))],
		[],
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("function with params with default value", () => {
	const input = `
func add(a: int, b = 5) {}
`;
	const parsed = parse(input);
	const expected = new FunctionNode(
		1,
		"mod",
		"add",
		new Type(""),
		[
			new ParameterNode(10, "a", new Type("int")),
			new ParameterNode(18, "b", new Type("int", true), new ValueNode(20, "5")),
		],
		[],
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("function with body", () => {
	const input = `
func add() {
  var x = 5
}
`;
	const parsed = parse(input);
	const expected = new FunctionNode(
		1,
		"mod",
		"add",
		new Type(""),
		[],
		[
			new DeclarationNode(
				16,
				"mod",
				"var",
				"x",
				new Type("int", true),
				new ValueNode(24, "5", new Type("int", true)),
			),
		],
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("function with return value", () => {
	const input = `
func add() -> int {
  return 5
}
`;
	const parsed = parse(input);
	const expected = new FunctionNode(
		1,
		"mod",
		"add",
		new Type("int", true),
		[],
		[new ReturnNode(23, new ValueNode(30, "5", new Type("int", true)), new Type("int", true))],
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("function followed by function", () => {
	const input = `
func add() {}

func subtract() {}
`;
	const parsed = parse(input);
	const expected = new RootNode(
		[],
		[
			new FunctionNode(1, "mod", "add", new Type(""), [], []),
			new FunctionNode(16, "mod", "subtract", new Type(""), [], []),
		],
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root)).toEqual(trim_test_parse(expected));
});
