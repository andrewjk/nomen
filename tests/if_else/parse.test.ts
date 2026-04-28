import { expect, test } from "vite-plus/test";

import AssignmentNode from "../../src/nodes/AssignmentNode.ts";
import BranchNode from "../../src/nodes/BranchNode.ts";
import DeclarationNode from "../../src/nodes/DeclarationNode.ts";
import IfElseNode from "../../src/nodes/IfElseNode.ts";
import OperationNode from "../../src/nodes/OperationNode.ts";
import ReturnNode from "../../src/nodes/ReturnNode.ts";
import Type from "../../src/nodes/Type.ts";
import ValueNode from "../../src/nodes/ValueNode.ts";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("If/else parse");

test("if", () => {
	const input = `
var x = 10
if x > 5 {
  x = 15
}
`;
	const parsed = parse(input);
	const expected = new IfElseNode(
		12,
		new OperationNode(
			15,
			">",
			new ValueNode(15, "x", new Type("int", true)),
			new ValueNode(19, "5", new Type("int", true)),
			new Type("bool"),
		),
		new BranchNode(25, [
			new AssignmentNode(
				25,
				new ValueNode(25, "x", new Type("int", true)),
				new ValueNode(29, "15", new Type("int", true)),
			),
		]),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("if else", () => {
	const input = `
var x = 10
if x > 5 {
  x = 15
} else {
  x = 20
}
`;
	const parsed = parse(input);
	const expected = new IfElseNode(
		12,
		new OperationNode(
			15,
			">",
			new ValueNode(15, "x", new Type("int", true)),
			new ValueNode(19, "5", new Type("int", true)),
			new Type("bool"),
		),
		new BranchNode(25, [
			new AssignmentNode(
				25,
				new ValueNode(25, "x", new Type("int", true)),
				new ValueNode(29, "15", new Type("int", true)),
			),
		]),
		new BranchNode(43, [
			new AssignmentNode(
				43,
				new ValueNode(43, "x", new Type("int", true)),
				new ValueNode(47, "20", new Type("int", true)),
			),
		]),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("if with boolean expression", () => {
	const input = `
var x = 10
if x + 1 > 5 {
  x = 15
}
`;
	const parsed = parse(input);
	const expected = new IfElseNode(
		12,
		new OperationNode(
			15,
			">",
			new OperationNode(
				15,
				"+",
				new ValueNode(15, "x", new Type("int", true)),
				new ValueNode(19, "1", new Type("int", true)),
				new Type("int", true),
			),
			new ValueNode(19, "5", new Type("int", true)),
			new Type("bool"),
		),
		new BranchNode(25, [
			new AssignmentNode(
				25,
				new ValueNode(25, "x", new Type("int", true)),
				new ValueNode(29, "15", new Type("int", true)),
			),
		]),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("declaration with if", () => {
	const input = `
const x = 10
const y = if x > 5 {
  return 50
} else {
  return 0
}
`;
	const parsed = parse(input);
	const expected = new DeclarationNode(
		14,
		"mod",
		"const",
		"y",
		new Type("int", true),
		new IfElseNode(
			24,
			new OperationNode(
				27,
				">",
				new ValueNode(27, "x", new Type("int", true)),
				new ValueNode(31, "5", new Type("int", true)),
				new Type("bool"),
			),
			new BranchNode(37, [
				new ReturnNode(37, new ValueNode(44, "50", new Type("int", true)), new Type("int", true)),
			]),
			new BranchNode(58, [
				new ReturnNode(58, new ValueNode(65, "0", new Type("int", true)), new Type("int", true)),
			]),
			new Type("int", true),
		),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("declaration with short if", () => {
	const input = `
const x = 10
const y = if x > 5 ~ 50
          else ~ 0
`;
	const parsed = parse(input);
	const expected = new DeclarationNode(
		14,
		"mod",
		"const",
		"y",
		new Type("int", true),
		new IfElseNode(
			24,
			new OperationNode(
				27,
				">",
				new ValueNode(27, "x", new Type("int", true)),
				new ValueNode(31, "5", new Type("int", true)),
				new Type("bool"),
			),
			new BranchNode(33, [
				new ReturnNode(33, new ValueNode(35, "50", new Type("int", true)), new Type("int", true)),
			]),
			new BranchNode(53, [
				new ReturnNode(53, new ValueNode(55, "0", new Type("int", true)), new Type("int", true)),
			]),
			new Type("int", true),
		),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("declaration with one line if", () => {
	const input = `
const x = 10
const y = if x > 5 ~ 50 else ~ 0
`;
	const parsed = parse(input);
	const expected = new DeclarationNode(
		14,
		"mod",
		"const",
		"y",
		new Type("int", true),
		new IfElseNode(
			24,
			new OperationNode(
				27,
				">",
				new ValueNode(27, "x", new Type("int", true)),
				new ValueNode(31, "5", new Type("int", true)),
				new Type("bool"),
			),
			new BranchNode(33, [
				new ReturnNode(33, new ValueNode(35, "50", new Type("int", true)), new Type("int", true)),
			]),
			new BranchNode(43, [
				new ReturnNode(43, new ValueNode(45, "0", new Type("int", true)), new Type("int", true)),
			]),
			new Type("int", true),
		),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});
