import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

/*
 * Container-stored class leak
 *
 * When a class instance is moved into a generic container (List, LinkedList,
 * Tree, Graph), the container stores the pointer via Buffer.store_int (type-erased
 * 8 bytes).  On container destroy the Buffer is freed, but the class instance
 * itself is never freed — nothing tracks it.  With audit mode enabled, this
 * shows up as "LEAK: 1 allocation(s)".
 *
 * Array<Animal> does NOT leak — heap_class_arrays tracks arrays of classes
 * and frees them on scope exit.
 */

describe("container-stored class leak", () => {
	test("List<Animal> — stored class not freed on container destroy", async () => {
		const input = `
mv struct Animal { var char letter }
if true {
	var List<Animal> list = List<Animal>()
	list.push(mv Animal('Z'))
}
Console.write("done\\n")
`;
		await build_and_check_output(input, "leak_list", "done");
	});

	test("LinkedList<Animal> — stored class not freed on container destroy", async () => {
		const input = `
mv struct Animal { var char letter }
if true {
	var LinkedList<Animal> list = LinkedList<Animal>()
	list.add(mv Animal('Z'))
}
Console.write("done\\n")
`;
		await build_and_check_output(input, "leak_ll", "done");
	});

	test("Tree<Box<Animal>> — stored element freed on container destroy", async () => {
		const input = `
mv struct Animal { var char letter }
if true {
	var Tree<Box<Animal>> t = Tree<Box<Animal>>()
	t.add(Box<Animal>(Animal('Z')))
}
Console.write("done\\n")
`;
		await build_and_check_output(input, "leak_tree", "done");
	});

	test("Graph<Box<Animal>> — stored element freed on container destroy", async () => {
		const input = `
mv struct Animal { var char letter }
if true {
	var Graph<Box<Animal>> g = Graph<Box<Animal>>()
	g.add_node(Box<Animal>(Animal('Z')))
}
Console.write("done\\n")
`;
		await build_and_check_output(input, "leak_graph", "done");
	});
});
