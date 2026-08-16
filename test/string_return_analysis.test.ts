import path from "node:path";

import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import type FunctionNode from "../src/nodes/FunctionNode";
import type RootNode from "../src/nodes/RootNode";
import type StructNode from "../src/nodes/StructNode";
import parse from "../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

function top_level_functions(root: RootNode): FunctionNode[] {
	return root.statements.filter((s) => s.node_type === "func") as unknown as FunctionNode[];
}

function struct_method(root: RootNode, struct_name: string, method: string): FunctionNode {
	const struct = root.statements.find(
		(s) => s.node_type === "struct" && (s as StructNode).name === struct_name,
	) as StructNode;
	return struct.functions.find((f) => f.name === method) as FunctionNode;
}

test("returns_string_borrow stamps borrow vs owned string returns (aarch64 gather)", () => {
	const input = `
import System

pub func echo = (string s, out string) { return s }

pub func shout = (string s, out string) { return s + "!" }

pub func pick = (int c, out string) {
	if c > 0 {
		return "yes"
	}
	return "no"
}

struct Named {
	var string name
	pub func get = (self, out string) { return self.name }
	pub func render = (self, out string) { return "<" + self.name + ">" }
}

pub func main = () {
	Console.write("\\{echo("hi")}")
}
`;
	const parsed = parse(input, system);
	expect(parsed.errors).toEqual([]);
	// The gather runs inside build (per-block pre-pass); build mutates but
	// the AST stamps survive on the nodes.
	build(parsed.root, { arch: "aarch64" });

	const by_name = new Map(top_level_functions(parsed.root).map((f) => [f.name, f]));
	// A parameter pass-through is a borrow.
	expect(by_name.get("echo")!.returns_string_borrow).toBe(true);
	// A concatenation produces a fresh heap string (owned).
	expect(by_name.get("shout")!.returns_string_borrow).toBe(false);
	// Literal-only returns are static storage (borrow), including through
	// if branches.
	expect(by_name.get("pick")!.returns_string_borrow).toBe(true);
	// A field access return is a borrow; building via concatenation is owned.
	expect(struct_method(parsed.root, "Named", "get").returns_string_borrow).toBe(true);
	expect(struct_method(parsed.root, "Named", "render").returns_string_borrow).toBe(false);
	// A non-string-returning function carries no stamp.
	expect(by_name.get("main")!.returns_string_borrow).toBeUndefined();
});

test("the C gather stamps every string-returning function as owned", () => {
	// C normalizes at the return site (boundary strdup), so its gather marks
	// even borrow-shaped returns owned — the stamp records the backend's
	// contract, not the body analysis.
	const input = `
import System

pub func echo = (string s, out string) { return s }

pub func main = () {
	Console.write("\\{echo("hi")}")
}
`;
	const parsed = parse(input, system);
	expect(parsed.errors).toEqual([]);
	build(parsed.root, { arch: "c" });
	const echo = top_level_functions(parsed.root).find((f) => f.name === "echo");
	expect(echo!.returns_string_borrow).toBe(false);
});

test("container borrow returns are owned (normalized at the return site), accessors stay borrows", () => {
	// Backend parity for returning a container borrow: a function returning
	// `xs.at(i)` hands the caller an independent copy (the return site
	// strdup's it), so it classifies as OWNED (heap-returning). The borrow
	// accessor's OWN body (`List.at`'s `return self.items.load_T(i)`) stays a
	// borrow — its call sites treat the result as non-owned. `Map<K,
	// string>.get` normalizes like any non-accessor function (its call sites
	// are not borrow-recognized), mirroring the C backend's strdup in `get`.
	const input = `
import System

pub func pick = (List<string> xs, out string) {
	var int i = 0
	if i >= 0 && i < xs.length {
		return xs.at(i)
	}
	return "none"
}

pub func pick_via_local = (List<string> xs, out string) {
	var int i = 0
	if i >= 0 && i < xs.length {
		const string t = xs.at(i)
		return t
	}
	return "none"
}

pub func main = () {
	var List<string> names = List<string>()
	names.push("zebra")
	var Map<int, string> m = Map<int, string>()
	Console.write("\\{pick(names)}")
}
`;
	const parsed = parse(input, system);
	expect(parsed.errors).toEqual([]);
	build(parsed.root, { arch: "aarch64" });

	const by_name = new Map(top_level_functions(parsed.root).map((f) => [f.name, f]));
	// A direct container-borrow return is normalized → owned.
	expect(by_name.get("pick")!.returns_string_borrow).toBe(false);
	// A borrow-initialized local returned is normalized → owned.
	expect(by_name.get("pick_via_local")!.returns_string_borrow).toBe(false);
	// The accessor's own body stays a borrow (call sites of `.at` don't free).
	expect(struct_method(parsed.root, "List_string", "at").returns_string_borrow).toBe(true);
	// A non-accessor container method returning a borrow (`Map.get`'s
	// `return self.values.load_T(idx)`) is normalized → owned.
	expect(struct_method(parsed.root, "Map_int_string", "get").returns_string_borrow).toBe(false);
});
