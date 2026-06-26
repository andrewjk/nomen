import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Mirrors the binarytrees benchmark using the arena Tree (single flat Buffer +
// int child indices) instead of `mov`-owned node pointers. Same shape of work
// -- recursively build a tree, traverse/count it, and bulk create/destroy --
// but with one owner so there is nothing to leak.

describe("arena binary tree", () => {
	test("build, count, and bulk-recreate an arena tree", async () => {
		const input = `
var Tree<int> t = Tree<int>()
func build = (ref Tree<int> tree, int depth, int parent, bool left) {
  var int idx = tree.count
  tree.add(0)
  if parent >= 0 {
    if left {
      tree.set_left(parent, idx)
    } else {
      tree.set_right(parent, idx)
    }
  }
  if depth > 0 {
    build(ref tree, depth - 1, idx, true)
    build(ref tree, depth - 1, idx, false)
  }
}
build(ref t, 3, -1, false)
var int root_count = t.count_nodes(0)
var int total = 0
var int i = 0
while i < 20 {
  var Tree<int> tmp = Tree<int>()
  build(ref tmp, 2, -1, false)
  total = total + tmp.count_nodes(0)
  i = i + 1
}
Console.write("root=\\{root_count} loop=\\{total}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("arena_binarytrees", result, "root=15 loop=140\n");
	});
});
