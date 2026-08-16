import path from "node:path";

import { expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import type AccessFunctionCallNode from "../src/nodes/AccessFunctionCallNode";
import type FunctionNode from "../src/nodes/FunctionNode";
import type RootNode from "../src/nodes/RootNode";
import type StructNode from "../src/nodes/StructNode";
import parse from "../src/parse";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

/** Collect every AccessFunctionCallNode found in a statement list. */
function collect_access_func_calls(
	statements: any[],
	out: AccessFunctionCallNode[] = [],
): AccessFunctionCallNode[] {
	for (const stmt of statements ?? []) {
		if (stmt?.node_type === "access" && stmt.access?.node_type === "access_func") {
			out.push(stmt.access as AccessFunctionCallNode);
		}
		if (Array.isArray(stmt?.statements)) collect_access_func_calls(stmt.statements, out);
		if (stmt?.value?.node_type) collect_access_func_calls([stmt.value], out);
		if (stmt?.if_branch?.statements) collect_access_func_calls(stmt.if_branch.statements, out);
		if (stmt?.else_branch?.statements) collect_access_func_calls(stmt.else_branch.statements, out);
		if (stmt?.condition?.node_type) collect_access_func_calls([stmt.condition], out);
	}
	return out;
}

/** Find a mono struct → method → all AccessFunctionCallNodes in its body. */
function find_mono_method_calls(
	root: RootNode,
	mono_name: string,
	method_name: string,
): AccessFunctionCallNode[] {
	const struct = root.statements.find(
		(s) => s.node_type === "struct" && (s as StructNode).name === mono_name,
	) as StructNode | undefined;
	if (!struct) throw new Error(`mono struct ${mono_name} not found`);
	const func = struct.functions.find((f) => f.name === method_name) as FunctionNode | undefined;
	if (!func) throw new Error(`method ${method_name} not found on ${mono_name}`);
	return collect_access_func_calls(func.statements);
}

function parse_with_system(source: string) {
	return parse(
		`
import System
pub func main = () {
${source}
}
`,
		system,
	);
}

test("rederive owned_return on mov-out method call inside mono body", () => {
	// Instantiating List<int> monomorphises the generic. The `pop` method's
	// body calls self.items.move_T(idx); move_T is `mov out T`, so the call
	// must carry owned_return = true on the mono body. Without the
	// re-derivation pass this annotation is absent (the mono body is never
	// re-checked).
	const parsed = parse_with_system(`
var List<int> list = List<int>()
list.push(1)
const int v = list.pop()
`);
	expect(parsed.errors).toEqual([]);

	const calls = find_mono_method_calls(parsed.root as RootNode, "List_int", "pop");
	const move_t_call = calls.find((c) => c.name === "move_T");
	expect(move_t_call).toBeDefined();
	expect(move_t_call!.owned_return).toBe(true);
});

test("rederive owned_return absent on borrow accessor inside mono body", () => {
	// Instantiating List<int> monomorphises the generic. The `at` method's
	// body calls self.items.load_T(i); load_T is NOT mov-out, so owned_return
	// must NOT be set.
	const parsed = parse_with_system(`
var List<int> list = List<int>()
list.push(1)
`);
	expect(parsed.errors).toEqual([]);

	const calls = find_mono_method_calls(parsed.root as RootNode, "List_int", "at");
	const load_t_call = calls.find((c) => c.name === "load_T");
	expect(load_t_call).toBeDefined();
	expect(load_t_call!.owned_return).toBeUndefined();
});

test("rederive return_bounds from a return-contract call inside mono body", () => {
	// List<T>.push's body calls self.items.grow_T(new_cap); Buffer<T>.grow_T
	// declares `out int: out >= needed`, so the mono List_int.push body's
	// grow_T call must carry the substituted return-contract bounds.
	const parsed = parse_with_system(`
var List<int> list = List<int>()
list.push(1)
`);
	expect(parsed.errors).toEqual([]);

	const calls = find_mono_method_calls(parsed.root as RootNode, "List_int", "push");
	const grow_call = calls.find((c) => c.name === "grow_T");
	expect(grow_call).toBeDefined();
	expect(grow_call!.return_bounds).toBeDefined();
	// `out >= needed` with the call arg substituted: needed → new_cap.
	expect(grow_call!.return_bounds!.lower).toContain("new_cap");
	expect(grow_call!.return_bounds!.upper).toEqual([]);
});

test("rederive return_bounds with a self-referencing contract inside mono body", () => {
	// Map<K,V>'s get/has/set bodies call self.find_slot(key, cap);
	// find_slot declares `out int: out >= 0 && out < cap` — no self
	// reference, but Tree.left/right do reference self (`out < self.count`).
	// Use Map (substitutes both a param bound and the receiver).
	const parsed = parse_with_system(`
var Map<string, int> m = Map<string, int>()
m.set("a", 1)
const int v = m.get("a")
`);
	expect(parsed.errors).toEqual([]);

	const calls = find_mono_method_calls(parsed.root as RootNode, "Map_string_int", "get");
	const find_slot_call = calls.find((c) => c.name === "find_slot");
	expect(find_slot_call).toBeDefined();
	expect(find_slot_call!.return_bounds).toBeDefined();
	expect(find_slot_call!.return_bounds!.lower).toContain("0");
	expect(find_slot_call!.return_bounds!.upper).toContain("cap");
});

test("rederive is_nursery_spawn on a nursery.spawn inside a mono body", () => {
	// A generic method that receives a Nursery and calls pool.spawn(work(n)).
	// The struct is declared AFTER main, so its generic body is unchecked at
	// monomorphization time (the clone-before-check ordering) — the spawn
	// annotations must come from the re-derivation pass. Mirrors what
	// check_nursery_spawn sets on a checked body: is_nursery_spawn,
	// owned_return, function_return_type, and Task<T> typing, plus the
	// Task<T> monomorphization so the build can emit the struct body.
	const parsed = parse(
		`
import System

func work = (int n, out int) {
	return n * 2
}

pub func main = () {
	async pool {
		var Runner<int> r = Runner<int>(5)
		r.run(21, ref pool)
	}
}

pub struct Runner<T> {
	pub var T value

	pub func run = (ref self, int n, ref Nursery pool) {
		pool.spawn(work(n))
	}
}
`,
		system,
	);
	expect(parsed.errors).toEqual([]);

	const calls = find_mono_method_calls(parsed.root as RootNode, "Runner_int", "run");
	const spawn_call = calls.find((c) => c.name === "spawn");
	expect(spawn_call).toBeDefined();
	expect(spawn_call!.is_nursery_spawn).toBe(true);
	expect(spawn_call!.owned_return).toBe(true);
	expect(spawn_call!.function_return_type?.name).toBe("int");
	expect(spawn_call!.type?.name).toBe("Task");
	expect(spawn_call!.type?.type_args?.[0]?.name).toBe("int");
	// Task<int> must be materialized (its struct body is emitted at build).
	const task_int = (parsed.root as RootNode).statements.find(
		(s) => s.node_type === "struct" && (s as StructNode).name === "Task_int",
	);
	expect(task_int).toBeDefined();
});
