import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// The arena adders are void (they mutate via `ref self`); a node's index is the
// container's count read BEFORE the add. This sidesteps a compiler limitation
// where capturing the return of a library struct's `ref self` method marks the
// receiver unusable. Read-only method results are captured freely.

describe("arena containers", () => {
	test("LinkedList<int> add, link, traverse", async () => {
		const input = `
var LinkedList<int> list = LinkedList<int>()
var int a = list.count
list.add(10)
var int b = list.count
list.add(20)
var int c = list.count
list.add(30)
list.set_next(a, b)
list.set_next(b, c)
var int sum = 0
var int cur = list.head
while cur != -1 {
  sum = sum + list.value(cur)
  cur = list.next(cur)
}
Console.write("len=\\{list.length()} sum=\\{sum}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("arena_linkedlist", result, "len=3 sum=60\n");
	});

	test("Tree<int> build and count nodes", async () => {
		const input = `
var Tree<int> t = Tree<int>()
var int l = t.count
t.add(0)
var int ll = t.count
t.add(0)
var int lr = t.count
t.add(0)
t.set_left(l, ll)
t.set_right(l, lr)
var int root = t.count
t.add(0)
t.set_left(root, l)
Console.write("nodes=\\{t.length()} count=\\{t.count_nodes(root)}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("arena_tree", result, "nodes=4 count=4\n");
	});

	test("Graph<int> add nodes and edges", async () => {
		const input = `
var Graph<int> g = Graph<int>()
var int a = g.node_count
g.add_node(1)
var int b = g.node_count
g.add_node(2)
var int c = g.node_count
g.add_node(3)
g.add_edge(a, b)
g.add_edge(a, c)
g.add_edge(b, c)
var int total = 0
var int e = g.first_edge(a)
while e != -1 {
  total = total + g.value(g.edge_target(e))
  e = g.next_edge(e)
}
Console.write("nodes=\\{g.node_length()} edges_from_a=\\{total}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("arena_graph", result, "nodes=3 edges_from_a=5\n");
	});
});
