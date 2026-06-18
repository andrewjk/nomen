import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("memory var class param", () => {
	test("passing class field to var class param should not double-free", async () => {
		const input = `
class Node {
	var int value = 0
	mov Node? child = null
}

func set_value = (var Node n) {
	if n.child != null {
		set_value(n.child)
	}
	n.value = 42
}

var Node root = Node()
var Node child = Node()
root.child = child
set_value(root)
Console.write("\\{root.value}")
Console.write("\\{child.value}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("var_class_param_borrowed_field", result, "4242");
	});

	test("recursive var class param with field access does not corrupt tree", async () => {
		const input = `
class TreeNode {
	var int data = 0
	mov TreeNode? left = null
	mov TreeNode? right = null
}

func fill = (var TreeNode node) {
	if node.left != null {
		fill(node.left)
	}
	if node.right != null {
		fill(node.right)
	}
	node.data = node.data + 1
}

var TreeNode a = TreeNode()
var TreeNode b = TreeNode()
var TreeNode c = TreeNode()
a.left = b
a.right = c
fill(a)
Console.write("\\{a.data}")
Console.write("\\{b.data}")
Console.write("\\{c.data}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("var_class_param_recursive_tree", result, "111");
	});
});
