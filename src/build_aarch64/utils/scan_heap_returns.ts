import BaseNode from "../../nodes/BaseNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import ReturnNode from "../../nodes/ReturnNode.ts";
import StructNode from "../../nodes/StructNode.ts";

const KNOWN_HEAP_RETURNING = new Set<string>([
	// NOTE: intentionally empty of static entries. Raw `#arch` library bodies
	// that hand back malloc'd strings declare `mov out string` in their .nm
	// signatures and classify through the checker's `owned_return` stamp; the
	// primitive `*_to_string` builtins are `mov out string` too (and every
	// consumer also recognizes them by their `*_to_string` label). Only
	// DYNAMIC entries land here anymore: string-returning functions consumed
	// through a `spawn` trampoline (scan_spawn_callees below) and functions
	// whose return sites produce heap values during building.
]);

export function scan_heap_returning_functions(root: BaseNode): Set<string> {
	const result = new Set<string>(KNOWN_HEAP_RETURNING);
	scan_statements((root as any).statements ?? [], result, undefined);
	scan_spawn_callees(root, result);
	return result;
}

/**
 * Every string-returning function spawned via `spawn` / `pool.spawn(...)` is
 * consumed through the task's C trampoline, where the aarch64 backend's
 * declaration-level heap tracking can't see the result — the value lands in
 * the typed result slot and is later moved out to the `result()` caller, who
 * frees it unconditionally (a `mov out string`). The callee must therefore
 * normalize EVERY return path to an owned heap copy (the return-site strdup
 * only fires for functions in this set), so a literal-only spawned function
 * doesn't hand `result()` a rodata pointer the caller would free.
 */
function scan_spawn_callees(root: BaseNode, result: Set<string>) {
	const visit = (node: any): void => {
		if (!node || typeof node !== "object") return;
		const name_and_ret: [string, { name?: string }] | undefined =
			node.node_type === "spawn"
				? [node.call?.name, node.function_return_type ?? {}]
				: node.node_type === "access_func" &&
					  node.is_nursery_spawn &&
					  node.params?.[0]?.node_type === "func_call"
					? [node.params[0].name, node.function_return_type ?? {}]
					: undefined;
		if (name_and_ret && name_and_ret[0] && name_and_ret[1].name === "string") {
			result.add(name_and_ret[0]);
		}
		for (const key of Object.keys(node)) {
			if (key === "parent" || key === "scope") continue;
			const val = node[key];
			if (Array.isArray(val)) {
				for (const item of val) visit(item);
			} else if (val && typeof val === "object") {
				visit(val);
			}
		}
	};
	visit(root);
}

function scan_statements(statements: any[], result: Set<string>, struct_name: string | undefined) {
	for (const stmt of statements) {
		if (stmt.node_type === "struct") {
			// Recurse into struct methods so e.g. Ansi.red / String.+ are detected.
			scan_statements((stmt as StructNode).functions ?? [], result, (stmt as StructNode).name);
			continue;
		}
		if (stmt.node_type === "func") {
			const func = stmt as FunctionNode;
			if (func.return_type?.name === "string" && func.has_body) {
				for (const s of func.statements) {
					if (
						s.node_type === "return" &&
						is_heap_string_expr((s as ReturnNode).value ?? undefined)
					) {
						// Match the label the build phase emits: `StructName_func_name`.
						const sanitized = func.name.replace(/#/g, "");
						const label = struct_name ? `${struct_name}_${sanitized}` : sanitized;
						result.add(label);
						break;
					}
				}
			}
			if (func.statements) {
				scan_statements(func.statements, result, struct_name);
			}
		}
	}
}

function is_heap_string_expr(node: BaseNode | undefined): boolean {
	if (!node) return false;

	if (node.node_type === "func_call") {
		const call = node as FunctionCallNode;
		if (call.name.startsWith("_string_interpolate_")) return true;
		if (call.name.endsWith("_to_string") && call.name !== "string_to_string") return true;
		return false;
	}

	if (node.node_type === "op") {
		const op = node as any;
		if (op.op === "*" && op.left_value?.type?.name === "string") return true;
		if (op.op === "+" && op.type?.name === "string") return true;
		return false;
	}

	// A control-flow expression (`return match/switch/if`) is heap-returning
	// when any branch's value is — each `-> expr` arrow branch wraps its value
	// in a let, `=> expr` in a return. Mirrors value_is_owned_string's branch
	// unwrapping so a `return match { ... -> "x \\{y}" }` function is
	// classified heap-returning even when declared after its callers.
	if (node.node_type === "match" || node.node_type === "switch") {
		const branches: any[] = ((node as any).cases ?? []).map((c: any) => c?.branch);
		if ((node as any).else_branch) branches.push((node as any).else_branch);
		return branches.some(branch_has_heap_value);
	}
	if (node.node_type === "if") {
		return (
			branch_has_heap_value((node as any).if_branch) ||
			branch_has_heap_value((node as any).else_branch)
		);
	}

	return false;
}

function branch_has_heap_value(block: any): boolean {
	for (const stmt of block?.statements ?? []) {
		if ((stmt?.node_type === "let" || stmt?.node_type === "return") && stmt.value) {
			if (is_heap_string_expr(stmt.value)) return true;
		}
	}
	return false;
}
