import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// KNOWN-FAILING leak test for the recursive-destroy bug.
//
// A class with `mov` (owning) class-typed fields is freed only one level deep:
// freeing a node releases its direct children, but never runs those children's
// destroys, so any subtree deeper than one level leaks. create_tree(3) has 15
// nodes but only 3 are freed (12 leak); create_tree(2) has 7 and leaks 4 --
// always exactly 3 freed regardless of depth.
//
// This is why the arena containers (LinkedList/Tree/Graph) keep everything in a
// single flat Buffer: cleanup is one flat free, which sidesteps this bug. This
// test stays failing until class auto-destroy recursively frees `mov` fields.

describe("recursive destroy leak", () => {
	test("mov-owned recursive tree leaks deeper than one level", async () => {
		const input = `
class TreeNode {
  mov TreeNode? left = null
  mov TreeNode? right = null
}

func create_tree = (int depth, out TreeNode) {
  var TreeNode node = TreeNode()
  if depth > 0 {
    var TreeNode l = create_tree(depth - 1)
    var TreeNode r = create_tree(depth - 1)
    node.left = l
    node.right = r
  }
  return node
}

func check_tree = (TreeNode node, out int) {
  var int sum = 1
  if node.left != null {
    sum = sum + check_tree(node.left)
  }
  if node.right != null {
    sum = sum + check_tree(node.right)
  }
  return sum
}

var TreeNode t = create_tree(3)
Console.write("\\{check_tree(t)}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("recursive_destroy_leak", result, "15\n");
	});
});
