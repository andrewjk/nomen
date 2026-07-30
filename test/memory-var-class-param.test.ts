import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("memory ref class param", () => {
	test("passing class field to ref class param should not double-free", async () => {
		const input = `
class Node {
	var int value = 0
	mov Node? child = null
}

func set_value = (ref Node n) {
	if n.child != null {
		set_value(ref n.child)
	}
	n.value = 42
}

var Node root = Node()
var Node child = Node()
root.child = child
set_value(ref root)
Console.write("\\{root.value}")
Console.write("\\{child.value}")
`;
		await build_and_check_output(input, "var_class_param_borrowed_field", "4242");
	});

	test("recursive ref class param with field access does not corrupt tree", async () => {
		const input = `
class TreeNode {
	var int data = 0
	mov TreeNode? left = null
	mov TreeNode? right = null
}

func fill = (ref TreeNode node) {
	if node.left != null {
		fill(ref node.left)
	}
	if node.right != null {
		fill(ref node.right)
	}
	node.data = node.data + 1
}

var TreeNode a = TreeNode()
var TreeNode b = TreeNode()
var TreeNode c = TreeNode()
a.left = b
a.right = c
fill(ref a)
Console.write("\\{a.data}")
Console.write("\\{b.data}")
Console.write("\\{c.data}")
`;
		await build_and_check_output(input, "var_class_param_recursive_tree", "111");
	});
});
