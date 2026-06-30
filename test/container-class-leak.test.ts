import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

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
class Animal { var char letter }
if true {
	var List<Animal> list = List<Animal>()
	list.push(mov Animal('Z'))
}
Console.write("done\\n")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_list", result, "done");
	});

	test("LinkedList<Animal> — stored class not freed on container destroy", async () => {
		const input = `
class Animal { var char letter }
if true {
	var LinkedList<Animal> list = LinkedList<Animal>()
	list.add(mov Animal('Z'))
}
Console.write("done\\n")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_ll", result, "done");
	});

	test("Tree<Animal> — stored class not freed on container destroy", async () => {
		const input = `
class Animal { var char letter }
if true {
	var Tree<Animal> t = Tree<Animal>()
	t.add(mov Animal('Z'))
}
Console.write("done\\n")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_tree", result, "done");
	});

	test("Graph<Animal> — stored class not freed on container destroy", async () => {
		const input = `
class Animal { var char letter }
if true {
	var Graph<Animal> g = Graph<Animal>()
	g.add_node(mov Animal('Z'))
}
Console.write("done\\n")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("leak_graph", result, "done");
	});
});
