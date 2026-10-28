import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { parse_raw } from "./parse_with_imports";
import { load_system_struct_names, system_lib_fresh } from "./system_lib";

// The harness tests build through build_and_check_output, whose split pipeline
// (emit_mode "user" against the prebuilt system.o) is only one of the two
// drivers. Driving the backends DIRECTLY — `parse_raw` + `build(arch:
// "aarch64")` for a single TU, or a user-TU build with the system struct set —
// used to crash on `(Init init)` mains (FOLLOWUP.md: a declaration node with no
// name/type/value routed into build_declaration_node, and an if/else with no
// condition reaching build_if_else_node). These tests pin the direct driver on
// those shapes: both must BUILD with zero errors, on both backends.

function build_direct(
	input: string,
	options: Parameters<typeof build>[1] = {},
): ReturnType<typeof build> {
	const parsed = parse_raw(input);
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { audit: true, ...options });
}

test("full-TU Init main builds directly on both backends", () => {
	const input = `
import System

func fake_int = (int k, out int) {
	return k * 2
}

pub func main = (Init init) {
	var List<int> nums = List<int>()
	nums.push(fake_int(21))
	Console.write("\\{nums.pop()}")
}
`;
	for (const arch of ["aarch64", "c"] as const) {
		const result = build_direct(input, { arch });
		expect(result.errors ?? []).toEqual([]);
	}
});

test("split user-TU Init main with StableList builds directly", () => {
	const input = `
import System

func fake_int = (int k, out int) {
	return k * 2
}

mv struct Rec {
	var int x
	var int y
}

func make_rec = (int x, int y, out Rec) {
	return Rec(x, y)
}

pub func main = (Init init) {
	var StableList<Rec> items = StableList<Rec>()
	var int i = 3
	items.push(make_rec(fake_int(i), i * 10))
	mv Rec r = items.at_or_panic(0)
	Console.write("\\{r.x},\\{r.y}")
}
`;
	const system_names = load_system_struct_names();
	for (const arch of ["aarch64", "c"] as const) {
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		// Same split policy as build_and_check_output: user TU against the
		// prebuilt system object when the cached build is fresh for this
		// arch+audit pair, single TU otherwise.
		const split = system_lib_fresh(arch, true);
		const result = split
			? build(parsed.root, {
					arch,
					audit: true,
					emit_mode: "user",
					system_struct_names: system_names,
				})
			: build(parsed.root, { arch, audit: true });
		expect(result.errors ?? []).toEqual([]);
	}
});

// The ground-truth backstops: the malformed nodes the checker never produces
// must be REPORTED as build errors, not crash the driver with a TypeError.

test("an if with no condition is reported, not crashed on", () => {
	const input = `
import System

pub func main = (Init init) {
	if true {
		Console.write("x")
	}
}
`;
	const parsed = parse_raw(input);
	expect(parsed.errors).toEqual([]);
	// Simulate the desugar residue: an if node stripped of its condition.
	const find_if = (n: any): any => {
		for (const stmt of n.statements ?? []) {
			if (stmt.node_type === "if") return stmt;
			const deep = find_if(stmt);
			if (deep) return deep;
		}
		return undefined;
	};
	const main = parsed.root.statements.find((s: any) => s.node_type === "func" && s.name === "main");
	const if_node = find_if(main);
	expect(if_node).toBeDefined();
	if_node.condition = undefined;
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect((result.errors ?? []).some((e) => e.message.includes("if with no condition"))).toBe(true);
});

test("a declaration with no name/type/value is reported, not crashed on", () => {
	const input = `
import System

pub func main = (Init init) {
	var int x = 4
	Console.write("\\{x}")
}
`;
	const parsed = parse_raw(input);
	expect(parsed.errors).toEqual([]);
	const main = parsed.root.statements.find((s: any) => s.node_type === "func" && s.name === "main");
	expect(main).toBeDefined();
	const decl = (main as any).statements.find((s: any) => s.node_type === "declare");
	expect(decl).toBeDefined();
	// The historic residue shape: a declare-shaped node with no name/type and
	// a stray `statements` field (the block/func-shaped misroute).
	decl.name = undefined;
	decl.type = undefined;
	decl.value = undefined;
	decl.statements = [];
	const result = build(parsed.root, { arch: "aarch64", audit: true });
	expect((result.errors ?? []).some((e) => e.message.includes("declaration with no name"))).toBe(
		true,
	);
});
