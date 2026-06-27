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
  sum = sum + list.at(cur)
  cur = list.next_at(cur)
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
var int e = g.edges_of(a)
while e != -1 {
  total = total + g.at(g.edge_target(e))
  e = g.next_edge(e)
}
Console.write("nodes=\\{g.node_length()} edges_from_a=\\{total}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("arena_graph", result, "nodes=3 edges_from_a=5\n");
	});

	test("LinkedList<Elephant> store and retrieve class pointers", async () => {
		const input = `
class Elephant {
  var char letter
  var bool visited = false
}

var LinkedList<Elephant> list = LinkedList<Elephant>()
var Elephant a = Elephant('A')
var Elephant b = Elephant('B')
var Elephant c = Elephant('C')
var int ia = list.count
list.add(mov a)
var int ib = list.count
list.add(mov b)
var int ic = list.count
list.add(mov c)
list.set_next(ia, ib)
list.set_next(ib, ic)
var Elephant cur = list.at(ia)
cur.visited = true
cur = list.at(ib)
cur.visited = true
cur = list.at(ic)
cur.visited = true
cur = list.at(ia)
Console.write("\\{cur.letter} ")
cur = list.at(ib)
Console.write("\\{cur.letter} ")
cur = list.at(ic)
Console.write("\\{cur.letter}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		// Elephants are mov'd into the list (ownership transfers), so they
		// aren't freed at scope exit. The container doesn't free stored
		// values on destroy yet — known limitation. Type safety (no UAF)
		// is the guarantee; the leak is expected.
		await check_output("linkedlist_class", result, "A B C\n", { audit: false });
	});

	test("Tree<Elephant> store and traverse class pointers", async () => {
		const input = `
class Elephant {
  var char letter
  var bool visited = false
}

var Tree<Elephant> t = Tree<Elephant>()
var int root = t.count
t.add(Elephant('R'))
var int left = t.count
t.add(Elephant('L'))
var int right = t.count
t.add(Elephant('R'))
t.set_left(root, left)
t.set_right(root, right)
var Elephant e = t.at(root)
e.visited = true
e = t.at(left)
e.visited = true
e = t.at(right)
e.visited = true
e = t.at(root)
Console.write("\\{e.letter} ")
e = t.at(left)
Console.write("\\{e.letter} ")
e = t.at(right)
Console.write("\\{e.letter}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("tree_class", result, "R L R\n");
	});

	test("Graph<Elephant> store and traverse class pointers", async () => {
		const input = `
class Elephant {
  var char letter
  var bool visited = false
}

var Graph<Elephant> g = Graph<Elephant>()
var int a = g.node_count
g.add_node(Elephant('A'))
var int b = g.node_count
g.add_node(Elephant('B'))
var int c = g.node_count
g.add_node(Elephant('C'))
g.add_edge(a, b)
g.add_edge(a, c)
var Elephant e = g.at(a)
e.visited = true
e = g.at(b)
e.visited = true
e = g.at(c)
e.visited = true
e = g.at(a)
Console.write("\\{e.letter} ")
e = g.at(b)
Console.write("\\{e.letter} ")
e = g.at(c)
Console.write("\\{e.letter}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_class", result, "A B C\n");
	});
});
