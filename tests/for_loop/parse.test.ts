import { expect, test } from "vite-plus/test";

import ForLoopNode from "../../src/nodes/ForLoopNode.ts";
import RangeNode from "../../src/nodes/RangeNode.ts";
import Type from "../../src/nodes/Type.ts";
import ValueNode from "../../src/nodes/ValueNode.ts";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("For loop parse");

test("with array", () => {
	const input = `
const y = [1, 2, 3]
for x of y {
  // ...
}
`;
	const parsed = parse(input);
	const expected = new ForLoopNode(
		21,
		new ValueNode(25, "x", new Type("int")),
		new ValueNode(30, "y", new Type("int", true, true, new ValueNode(-1, "3", new Type("int")))),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("with range", () => {
	const input = `
for x of 0..5 {}
`;
	const parsed = parse(input);
	const expected = new ForLoopNode(
		1,
		new ValueNode(5, "x", new Type("int")),
		new RangeNode(
			10,
			new ValueNode(10, "0", new Type("int", true)),
			new ValueNode(13, "5", new Type("int", true)),
			false,
		),
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});
