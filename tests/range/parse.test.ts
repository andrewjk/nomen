import { expect, test } from "vite-plus/test";

import DeclarationNode from "../../src/nodes/DeclarationNode.ts";
import RangeNode from "../../src/nodes/RangeNode.ts";
import Type from "../../src/nodes/Type.ts";
import ValueNode from "../../src/nodes/ValueNode.ts";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("Range parse");

test("exclusive", () => {
	const input = `
var x = 1..2
`;
	const parsed = parse(input);
	const expected = new DeclarationNode(
		1,
		"mod",
		"var",
		"x",
		new Type("int", true, true),
		new RangeNode(
			9,
			new ValueNode(9, "1", new Type("int", true)),
			new ValueNode(12, "2", new Type("int", true)),
			false,
		),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});

test("inclusive", () => {
	const input = `
var x = 1.=2
`;
	const parsed = parse(input);
	const expected = new DeclarationNode(
		1,
		"mod",
		"var",
		"x",
		new Type("int", true, true),
		new RangeNode(
			9,
			new ValueNode(9, "1", new Type("int", true)),
			new ValueNode(12, "2", new Type("int", true)),
			true,
		),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});
