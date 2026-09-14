import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// Arena<T>: a generational arena — one owner of a set of values, addressed by
// copyable `ArenaRef<T>` handles. It is the single-ownership answer to "many
// places need to refer to the same node" (the allmark PORT arena-pattern item):
// the arena owns the values, callers hold handles, and a handle to a freed
// (or recycled) slot is DETECTED via its generation instead of silently
// aliasing another value.

describe("Arena<T> generational handles", () => {
	test("alloc / get / free / is_valid — stale handle detected, slot reused", async () => {
		const input = `import System

pub func main = (Init init) {
	var Arena<string> a = Arena<string>()
	var ArenaRef<string> r0 = a.alloc("hello")
	var ArenaRef<string> r1 = a.alloc("world")
	Console.write("\\{a.get(r0)} \\{a.get(r1)}\\n")
	a.free(r0)
	if a.is_valid(r0) {
		Console.write("stale-valid(bad)\\n")
	} else {
		Console.write("r0-stale\\n")
	}
	if a.is_valid(r1) {
		Console.write("r1-live\\n")
	}
	// The freed slot is reused, but the OLD handle stays stale — the
	// generation, not the index, is what makes it safe.
	var ArenaRef<string> r2 = a.alloc("reused")
	Console.write("r0idx=\\{r0.index} r2idx=\\{r2.index}\\n")
	Console.write("r0_still_stale=\\{a.is_valid(r0)}\\n")
	Console.write("\\{a.get(r2)}\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"arena_basic",
			"hello world\nr0-stale\nr1-live\nr0idx=0 r2idx=0\nr0_still_stale=false\nreused\n",
			true,
		);
	});

	test("value-struct payloads (alloc / get / set)", async () => {
		const input = `import System

pub struct Node {
	pub var int v
	pub var string label
}

pub func main = (Init init) {
	var Arena<Node> a = Arena<Node>()
	var Node n = Node(7, "seven")
	var ArenaRef<Node> r = a.alloc(move n)
	Console.write("\\{a.get(r).v} \\{a.get(r).label}\\n")
	var Node m = Node(8, "eight")
	a.set(r, move m)
	Console.write("\\{a.get(r).v} \\{a.get(r).label}\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "arena_value_struct", "7 seven\n8 eight\n", true);
	});

	test("class payloads (owned instance reclaimed on free)", async () => {
		const input = `import System

pub class Box {
	pub var int v
}

pub func main = (Init init) {
	var Arena<Box> a = Arena<Box>()
	var ArenaRef<Box> r = a.alloc(Box(5))
	Console.write("\\{a.get(r).v}\\n")
	a.free(r)
	var ArenaRef<Box> r2 = a.alloc(Box(6))
	Console.write("\\{a.get(r2).v}\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "arena_class", "5\n6\n", true);
	});

	test("owned value releases on free (audit-clean)", async () => {
		// A string payload's heap copy must be reclaimed when the slot is
		// freed — audit on, repeated so a leak would surface.
		const input = `import System

pub func main = (Init init) {
	var Arena<string> a = Arena<string>()
	var int i = 0
	while i < 8 {
		var ArenaRef<string> r = a.alloc("payload-number-\\{i}")
		if i % 2 == 0 {
			a.free(r)
		}
		i = i + 1
	}
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "arena_owned_free", "done\n", true);
	});

	test("an ArenaRef handle copies freely — the same node in two lists", async () => {
		// The allmark PORT blocker: `parent.children.push(node); open =
		// open.push(node)` was impossible with direct references (`List.push`
		// takes `move T`, and a second store of the same instance is a
		// double-own / borrow invalidation). A handle owns nothing, so it
		// pushes into both lists without `move` and stays usable.
		const input = `import System

pub class Node {
	pub var int v
}

pub func main = (Init init) {
	var Arena<Node> arena = Arena<Node>()
	var List<ArenaRef<Node>> children = List<ArenaRef<Node>>()
	var List<ArenaRef<Node>> open_nodes = List<ArenaRef<Node>>()

	var ArenaRef<Node> r = arena.alloc(Node(1))
	children.push(r)
	open_nodes.push(r)
	Console.write("v=\\{arena.get(r).v}\\n")
	Console.write("c=\\{children.length} o=\\{open_nodes.length}\\n")
	var ArenaRef<Node> c0 = children.at_or_panic(0)
	var ArenaRef<Node> o0 = open_nodes.at_or_panic(0)
	Console.write("same=\\{arena.get(c0).v == arena.get(o0).v}\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(
			input,
			"arena_push_handle_twice",
			"v=1\nc=1 o=1\nsame=true\n",
			true,
		);
	});

	test("stale get / free panic (build-and-inspect: panic paths exit non-zero)", () => {
		// The run harness treats a non-zero exit as failure, so — like the
		// `_or_panic` family (test/accessor_or.test.ts) — verify the emitted
		// code carries the trap.
		const input = `import System
pub func main = (Init init) {
	var Arena<string> a = Arena<string>()
	var ArenaRef<string> r = a.alloc("gone")
	a.free(r)
	Console.write("\\{a.get(r)}\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c" });
		expect(result.code).toContain("arena: get of a stale handle");
		const result_a64 = build(parsed.root, { arch: "aarch64" });
		expect(result_a64.code).toContain("arena: get of a stale handle");
	});
});
