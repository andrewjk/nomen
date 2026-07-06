import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("Graph<T> add_node and value", () => {
	test("add single node and read back", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(42)
if g.node_count > 0 {
  var int v = g.first()
  Console.write("\\{v}")
}
`;
		await build_and_check_output(input, "graph_add_single", "42");
	});

	test("add multiple nodes preserves order", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(10)
g.add_node(20)
g.add_node(30)
for i of 0 .. g.node_count {
  var int v = g.at(i)
  if i > 0 {
    Console.write(" ")
  }
  Console.write("\\{v}")
}
`;
		await build_and_check_output(input, "graph_add_order", "10 20 30");
	});

	test("node_length tracks additions", async () => {
		const input = `
var Graph<int> g = Graph<int>()
var int n0 = g.node_length()
g.add_node(1)
var int n1 = g.node_length()
g.add_node(2)
g.add_node(3)
var int n3 = g.node_length()
Console.write("\\{n0} \\{n1} \\{n3}")
`;
		await build_and_check_output(input, "graph_node_length", "0 1 3");
	});

	test("empty graph node_length is zero", async () => {
		const input = `
var Graph<int> g = Graph<int>()
Console.write("\\{g.node_length()}")
`;
		await build_and_check_output(input, "graph_empty", "0");
	});

	test("add negative values", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(-1)
g.add_node(-100)
for i of 0 .. g.node_count {
  var int v = g.at(i)
  if i > 0 {
    Console.write(" ")
  }
  Console.write("\\{v}")
}
`;
		await build_and_check_output(input, "graph_negative", "-1 -100");
	});
});

describe("Graph<T> edges", () => {
	test("add single edge and traverse", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(1)
g.add_node(2)
g.add_edge(0, 1)
var int e = g.edges_of(0)
var int target = g.edge_target(e)
var int v = g.at(target)
Console.write("\\{v}")
`;
		await build_and_check_output(input, "graph_single_edge", "2");
	});

	test("edge_length tracks edges", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(1)
g.add_node(2)
g.add_node(3)
var int e0 = g.edge_length()
g.add_edge(0, 1)
var int e1 = g.edge_length()
g.add_edge(0, 2)
g.add_edge(1, 2)
var int e3 = g.edge_length()
Console.write("\\{e0} \\{e1} \\{e3}")
`;
		await build_and_check_output(input, "graph_edge_length", "0 1 3");
	});

	test("first_edge of node with no edges is -1", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(1)
var int e = g.edges_of(0)
Console.write("\\{e}")
`;
		await build_and_check_output(input, "graph_no_edges", "-1");
	});

	test("multiple outgoing edges traversed in reverse order", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(0)
g.add_node(10)
g.add_node(20)
g.add_edge(0, 1)
g.add_edge(0, 2)
var int sum = 0
var int e = g.edges_of(0)
while e != -1 {
  var int target = g.edge_target(e)
  sum = sum + g.at(target)
  e = g.next_edge(e)
}
Console.write("\\{sum}")
`;
		await build_and_check_output(input, "graph_multi_edges", "30");
	});
});

describe("Graph<T> adjacency traversal", () => {
	test("walk adjacency list summing values", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(1)
g.add_node(2)
g.add_node(3)
g.add_edge(0, 1)
g.add_edge(0, 2)
g.add_edge(1, 2)
var int total = 0
var int e = g.edges_of(0)
while e != -1 {
  var int target = g.edge_target(e)
  total = total + g.at(target)
  e = g.next_edge(e)
}
Console.write("\\{total}")
`;
		await build_and_check_output(input, "graph_walk", "5");
	});

	test("node with multiple edges to different nodes", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(0)
g.add_node(100)
g.add_node(200)
g.add_node(300)
g.add_edge(0, 1)
g.add_edge(0, 2)
g.add_edge(0, 3)
var int sum = 0
var int e = g.edges_of(0)
while e != -1 {
  var int target = g.edge_target(e)
  sum = sum + g.at(target)
  e = g.next_edge(e)
}
Console.write("\\{sum}")
`;
		await build_and_check_output(input, "graph_three_edges", "600");
	});

	test("disconnected nodes have no edges", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(1)
g.add_node(2)
g.add_node(3)
var int e0 = g.edges_of(0)
var int e1 = g.edges_of(1)
var int e2 = g.edges_of(2)
Console.write("\\{e0} \\{e1} \\{e2}")
`;
		await build_and_check_output(input, "graph_disconnected", "-1 -1 -1");
	});

	test("chain of edges via node-by-node traversal", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(1)
g.add_node(2)
g.add_node(3)
g.add_edge(0, 1)
g.add_edge(1, 2)
var int sum = 0
var int e = g.edges_of(0)
while e != -1 {
  var int t = g.edge_target(e)
  sum = sum + g.at(t)
  var int e2 = g.edges_of(t)
  while e2 != -1 {
    var int t2 = g.edge_target(e2)
    sum = sum + g.at(t2)
    e2 = g.next_edge(e2)
  }
  e = g.next_edge(e)
}
Console.write("\\{sum}")
`;
		await build_and_check_output(input, "graph_chain", "5");
	});
});
