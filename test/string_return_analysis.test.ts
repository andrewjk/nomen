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
