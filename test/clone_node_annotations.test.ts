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
