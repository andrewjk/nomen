import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Regression test for the recursive-destroy bug (was KNOWN-FAILING).
//
// A struct with `mv` class-typed fields used to be freed only one level
// deep: freeing a node released its direct children but never ran those
// children's destroys, so any subtree deeper than one level leaked
// (create_tree(3) has 15 nodes but only 3 were freed). Recursive destroy
// of mv-owned fields now runs the full subtree's teardown; this test pins
// that fix — a regression fails with `LEAK:` from the audit runtime.

describe("recursive destroy leak", () => {
	test("boxed recursive tree stores, traverses, and frees completely", async () => {
		const input = `
mv struct TreeNode {
  var Box<TreeNode>? left = null
  var Box<TreeNode>? right = null
}

func create_tree = (int depth, out TreeNode) {
  var TreeNode node = TreeNode()
  if depth > 0 {
    node.left = Box<TreeNode>(create_tree(depth - 1))
    node.right = Box<TreeNode>(create_tree(depth - 1))
  }
  return node
}

func check_tree = (ref Box<TreeNode> node, out int) {
  var int sum = 1
  if node.left != null {
    sum = sum + check_tree(ref node.left)
  }
  if node.right != null {
    sum = sum + check_tree(ref node.right)
  }
  return sum
}

var Box<TreeNode> t = Box<TreeNode>(create_tree(3))
Console.write("\\{check_tree(ref t)}\\n")
`;
		await build_and_check_output(input, "recursive_destroy_leak", "15\n");
	});
});
