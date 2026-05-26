import { expect, test } from "vite-plus/test";

import AssignmentNode from "../../src/nodes/AssignmentNode.ts";
import OperationNode from "../../src/nodes/OperationNode.ts";
import Type from "../../src/nodes/Type.ts";
import ValueNode from "../../src/nodes/ValueNode.ts";
import WhileLoopNode from "../../src/nodes/WhileLoopNode.ts";
import parse from "../../src/parse";
import trim_test_parse from "../trim_test_parse";

//const test = suite("While loop parse");

test("while", () => {
	const input = `
var x = 0
while x < 5 {
  x = x + 1
}
`;
	const parsed = parse(input);
	const expected = new WhileLoopNode(
		11,
		new OperationNode(
			17,
			"<",
			new ValueNode(17, "x", new Type("int", true)),
			new ValueNode(21, "5", new Type("int", true)),
			new Type("bool"),
		),
		[
			new AssignmentNode(
				27,
				new ValueNode(27, "x", new Type("int", true)),
				new OperationNode(
					31,
					"+",
					new ValueNode(31, "x", new Type("int", true)),
					new ValueNode(35, "1", new Type("int", true)),
					new Type("int", true),
				),
			),
		],
	);
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[1])).toEqual(trim_test_parse(expected));
});

test("while true", () => {
	const input = `
while true {
  // ...
}
`;
	const parsed = parse(input);
	const expected = new WhileLoopNode(1, new ValueNode(7, "true", new Type("bool", true)));
	expect(parsed.errors).toEqual([]);
	expect(trim_test_parse(parsed.root.statements[0])).toEqual(trim_test_parse(expected));
});
