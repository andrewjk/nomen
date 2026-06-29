import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("Tree<T> add and value", () => {
	test("add single node and read back", async () => {
		const input = `
var Tree<int> t = Tree<int>()
t.add(42)
if t.count > 0 {
  var int v = t.first()
  Console.write("\\{v}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_add_single", result, "42");
	});

	test("add multiple nodes preserves order", async () => {
		const input = `
var Tree<int> t = Tree<int>()
t.add(10)
t.add(20)
t.add(30)
for i of 0 .. t.count {
  var int v = t.at(i)
  if i > 0 {
    Console.write(" ")
  }
  Console.write("\\{v}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_add_order", result, "10 20 30");
	});

	test("length tracks additions", async () => {
		const input = `
var Tree<int> t = Tree<int>()
var int l0 = t.length()
t.add(1)
var int l1 = t.length()
t.add(2)
t.add(3)
var int l3 = t.length()
Console.write("\\{l0} \\{l1} \\{l3}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_length", result, "0 1 3");
	});

	test("empty tree length is zero", async () => {
		const input = `
var Tree<int> t = Tree<int>()
Console.write("\\{t.length()}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_empty_length", result, "0");
	});

	test("add negative values", async () => {
		const input = `
var Tree<int> t = Tree<int>()
t.add(-5)
t.add(-10)
for i of 0 .. t.count {
  var int v = t.at(i)
  if i > 0 {
    Console.write(" ")
  }
  Console.write("\\{v}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_negative", result, "-5 -10");
	});
});

describe("Tree<T> child pointers", () => {
	test("set_left and read back", async () => {
		const input = `
var Tree<int> t = Tree<int>()
var int root = t.count
t.add(0)
var int lc = t.count
t.add(10)
t.set_left(root, lc)
var int left_idx = t.left(root)
if left_idx >= 0 && left_idx < t.count {
  var int lv = t.at(left_idx)
  Console.write("\\{lv}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_left", result, "10");
	});

	test("set_right and read back", async () => {
		const input = `
var Tree<int> t = Tree<int>()
var int root = t.count
t.add(0)
var int rc = t.count
t.add(20)
t.set_right(root, rc)
var int right_idx = t.right(root)
if right_idx >= 0 && right_idx < t.count {
  var int rv = t.at(right_idx)
  Console.write("\\{rv}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_right", result, "20");
	});

	test("left of childless node is -1", async () => {
		const input = `
var Tree<int> t = Tree<int>()
t.add(0)
var int l = t.left(0)
Console.write("\\{l}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_no_left", result, "-1");
	});

	test("right of childless node is -1", async () => {
		const input = `
var Tree<int> t = Tree<int>()
t.add(0)
var int r = t.right(0)
Console.write("\\{r}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_no_right", result, "-1");
	});

	test("build binary tree with two children", async () => {
		const input = `
var Tree<int> t = Tree<int>()
var int root = t.count
t.add(1)
var int lc = t.count
t.add(2)
var int rc = t.count
t.add(3)
t.set_left(root, lc)
t.set_right(root, rc)
var int li = t.left(root)
var int ri = t.right(root)
if li >= 0 && li < t.count && ri >= 0 && ri < t.count {
  var int lv = t.at(li)
  var int rv = t.at(ri)
  Console.write("\\{lv} \\{rv}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_binary", result, "2 3");
	});
});

describe("Tree<T> count_nodes", () => {
	test("single node count is 1", async () => {
		const input = `
var Tree<int> t = Tree<int>()
t.add(0)
Console.write("\\{t.count_nodes(0)}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_count_single", result, "1");
	});

	test("count empty subtree is 0", async () => {
		const input = `
var Tree<int> t = Tree<int>()
Console.write("\\{t.count_nodes(-1)}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_count_empty", result, "0");
	});

	test("count balanced tree", async () => {
		const input = `
var Tree<int> t = Tree<int>()
var int root = t.count
t.add(0)
var int lc = t.count
t.add(0)
var int rc = t.count
t.add(0)
t.set_left(root, lc)
t.set_right(root, rc)
Console.write("\\{t.count_nodes(root)}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_count_balanced", result, "3");
	});

	test("count left-heavy tree", async () => {
		const input = `
var Tree<int> t = Tree<int>()
var int root = t.count
t.add(0)
var int lc = t.count
t.add(0)
t.set_left(root, lc)
var int llc = t.count
t.add(0)
t.set_left(lc, llc)
Console.write("\\{t.count_nodes(root)}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_count_left_heavy", result, "3");
	});
});

describe("Tree<T> recursive traversal", () => {
	test("sum all node values via recursion", async () => {
		const input = `
var Tree<int> t = Tree<int>()
func sum_tree = (Tree<int> tree, int idx, out int) {
  if idx >= 0 && idx < tree.count {
    var int v = tree.at(idx)
    return v + sum_tree(tree, tree.left(idx)) + sum_tree(tree, tree.right(idx))
  }
  return 0
}
var int root = t.count
t.add(10)
var int lc = t.count
t.add(20)
var int rc = t.count
t.add(30)
t.set_left(root, lc)
t.set_right(root, rc)
var int total = sum_tree(t, root)
Console.write("\\{total}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_sum_recursive", result, "60");
	});
});
