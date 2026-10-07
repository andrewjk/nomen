import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// KNOWN-FAILING leak test for the recursive-destroy bug.
//
// A class with `move` (owning) class-typed fields is freed only one level deep:
// freeing a node releases its direct children, but never runs those children's
// destroys, so any subtree deeper than one level leaks. create_tree(3) has 15
// nodes but only 3 are freed (12 leak); create_tree(2) has 7 and leaks 4 --
// always exactly 3 freed regardless of depth.
//
// This is why the arena containers (LinkedList/Tree/Graph) keep everything in a
// single flat Buffer: cleanup is one flat free, which sidesteps this bug. This
// test stays failing until class auto-destroy recursively frees `move` fields.

describe("recursive destroy leak", () => {
	test("boxed recursive tree stores, traverses, and frees completely", async () => {
		const input = `
owning struct TreeNode {
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
