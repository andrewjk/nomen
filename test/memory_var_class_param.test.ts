import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("memory ref class param", () => {
	test("passing a boxed child to a ref param does not double-free", async () => {
		const input = `
import System
mv struct Node {
	var int value = 0
	var Box<Node>? child = null
}

func set_value = (ref Box<Node> n) {
	if n.child != null {
		set_value(ref n.child)
	}
	n.value = 42
}

pub func main = () {
	var Box<Node> root = Box<Node>(Node())
	root.child = Box<Node>(Node())
	set_value(ref root)
	Console.write("\\{root.value}")
	Console.write("\\{root.child.value}")
}
`;
		await build_and_check_output(input, "var_class_param_borrowed_field", "4242", true);
	});

	test("recursive ref param over a boxed tree does not corrupt it", async () => {
		const input = `
import System
mv struct TreeNode {
	var int data = 0
	var Box<TreeNode>? left = null
	var Box<TreeNode>? right = null
}

func fill = (ref Box<TreeNode> node) {
	if node.left != null {
		fill(ref node.left)
	}
	if node.right != null {
		fill(ref node.right)
	}
	node.data = node.data + 1
}

pub func main = () {
	var Box<TreeNode> a = Box<TreeNode>(TreeNode())
	a.left = Box<TreeNode>(TreeNode())
	a.right = Box<TreeNode>(TreeNode())
	fill(ref a)
	Console.write("\\{a.data}")
	Console.write("\\{a.left.data}")
	Console.write("\\{a.right.data}")
}
`;
		await build_and_check_output(input, "var_class_param_recursive_tree", "111", true);
	});
});
