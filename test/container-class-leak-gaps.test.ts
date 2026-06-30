import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// These tests probe the gaps left by the `has_class_refs` auto-free mechanism
// added in the "Fix: leaks from collections" commit. Buffer#destroy now walks
// every slot and `free()`s it when the flag is set, which fixes the single
// push/add-then-scope-exit case. The tests below assert the *correct* behavior
// for ownership scenarios that mechanism does not cover; each is expected to
// FAIL until the gaps are closed.

describe("container class-ref auto-free: remaining gaps", () => {
	// #1 — pop() relinquishes a pointer but does not clear the slot. If that
	// pointer is then moved into a second container, both containers free it on
	// destroy → double free.
	test("List.pop() leaves a stale slot that double-frees when re-inserted", async () => {
		const input = `
class Animal { var char letter }
var List<Animal> l1 = List<Animal>()
var List<Animal> l2 = List<Animal>()
l1.push(mov Animal('A'))
var Animal x = l1.pop()
l2.push(mov x)
Console.write("ok\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("gap_pop_double_free", result, "ok\n");
	});

	// #2 — set() overwrites the slot without freeing the previous element, so
	// the replaced class instance leaks.
	test("List.set() leaks the overwritten class element", async () => {
		const input = `
class Animal { var char letter }
if true {
	var List<Animal> list = List<Animal>()
	list.push(mov Animal('A'))
	if list.length > 0 {
		list.set(0, mov Animal('B'))
		Console.write("\\{list.at(0).letter}")
	}
}
Console.write("\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("gap_set_overwrite", result, "B\n");
	});

	// #3 — Buffer#destroy calls bare free() on each slot. A class #destroy that
	// releases resources never runs for container-stored instances.
	test("class #destroy is not invoked for container-stored elements", async () => {
		const input = `
class Resource {
	var int handle
	func #destroy = () {
		Console.write("destroyed\\n")
	}
}
if true {
	var List<Resource> list = List<Resource>()
	list.push(mov Resource(1))
}
Console.write("done\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("gap_destroy_not_run", result, "destroyed\ndone\n");
	});

	// #4 — A class owning another class (mov Box) freed correctly when held as a
	// local, but when stored in a container the raw free() does not recurse, so
	// the owned inner class leaks.
	test("container-stored class with owned class field leaks the inner class", async () => {
		const input = `
class Box { var int v }
class Holder { mov Box content }
if true {
	var List<Holder> list = List<Holder>()
	list.push(mov Holder(mov Box(7)))
}
Console.write("done\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("gap_nested_owned_class", result, "done\n");
	});
});
