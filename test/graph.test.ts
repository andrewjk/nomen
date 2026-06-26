import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("Graph<T> add_node and value", () => {
	test("add single node and read back", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(42)
var int v = g.at(0)
Console.write("\\{v}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_add_single", result, "42");
	});

	test("add multiple nodes preserves order", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(10)
g.add_node(20)
g.add_node(30)
var int a = g.at(0)
var int b = g.at(1)
var int c = g.at(2)
Console.write("\\{a} \\{b} \\{c}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_add_order", result, "10 20 30");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_node_length", result, "0 1 3");
	});

	test("empty graph node_length is zero", async () => {
		const input = `
var Graph<int> g = Graph<int>()
Console.write("\\{g.node_length()}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_empty", result, "0");
	});

	test("add negative values", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(-1)
g.add_node(-100)
var int a = g.at(0)
var int b = g.at(1)
Console.write("\\{a} \\{b}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_negative", result, "-1 -100");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_single_edge", result, "2");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_edge_length", result, "0 1 3");
	});

	test("first_edge of node with no edges is -1", async () => {
		const input = `
var Graph<int> g = Graph<int>()
g.add_node(1)
var int e = g.edges_of(0)
Console.write("\\{e}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_no_edges", result, "-1");
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
  sum = sum + g.at(g.edge_target(e))
  e = g.next_edge(e)
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_multi_edges", result, "30");
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
  total = total + g.at(g.edge_target(e))
  e = g.next_edge(e)
}
Console.write("\\{total}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_walk", result, "5");
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
  sum = sum + g.at(g.edge_target(e))
  e = g.next_edge(e)
}
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_three_edges", result, "600");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_disconnected", result, "-1 -1 -1");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("graph_chain", result, "5");
	});
});
