import { SIMPLE_TYPES } from "../../built_in_types.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";

const MAX_STATEMENTS = 15;

export function scan_inline_candidates(root: BaseNode): Map<string, BaseNode> {
	// Collect every plain `func` statement in the tree — top-level AND nested
	// inside other function bodies (the checker rejects closures, so a nested
	// body only references its own params/locals and globals, making it safe
	// to inline anywhere). Struct/trait/extend subtrees are skipped: their
	// FunctionNodes are methods (labeled Struct_name, self-typed) served by
	// the method-inline path, not the flat function namespace.
	const counts = new Map<string, number>();
	const defs = new Map<string, FunctionNode>();
	collect_function_statements(root, counts, defs);

	const result = new Map<string, BaseNode>();
	for (const [name, func] of defs) {
		// A name defined by more than one function is ambiguous in the flat
		// call namespace (duplicate labels at emission) — never inline it.
		if ((counts.get(name) ?? 0) !== 1) continue;
		if (is_inline_candidate(func)) {
			result.set(name, func);
		}
	}
	return result;
}

function collect_function_statements(
	node: BaseNode | null | undefined,
	counts: Map<string, number>,
	defs: Map<string, FunctionNode>,
) {
	if (!node || typeof node !== "object") return;
	const any_node = node as any;
	const nt = any_node.node_type as string;
	if (nt === "struct" || nt === "trait" || nt === "extend") return;
	if (nt === "func") {
		const func = node as FunctionNode;
		if (func.name) {
			counts.set(func.name, (counts.get(func.name) ?? 0) + 1);
			defs.set(func.name, func);
		}
	}
	for (const key of Object.keys(any_node)) {
		if (key === "parent" || key === "scope") continue;
		const val = any_node[key];
		if (Array.isArray(val)) {
			for (const item of val) {
				if (item && typeof item === "object" && typeof item.node_type === "string") {
					collect_function_statements(item as BaseNode, counts, defs);
				}
			}
		} else if (val && typeof val === "object" && typeof val.node_type === "string") {
			collect_function_statements(val as BaseNode, counts, defs);
		}
	}
}

function is_inline_candidate(func: FunctionNode): boolean {
	if (!func.has_body) return false;
	if (func.is_inline) return false;
	if (func.statements.length === 0 || func.statements.length > MAX_STATEMENTS) return false;
	if (func.returns_mov) return false;
	// Raw-block (FFI) functions have arch-specific bodies (`#arch: c`,
	// `aarch64_use_c`, raw `aarch64`, …) that the general inline path can't
	// splice in: a companion-C body emits nothing inline, leaving the call a
	// no-op (the args get set up then discarded). Such functions are already
	// emitted as standalone callable symbols, so force a real `bl` instead.
	if (func.statements.some((s) => s.node_type === "raw")) return false;

	for (const param of func.params) {
		if (param.is_variadic || param.is_variadic_tuple) return false;
		if (!SIMPLE_TYPES.includes(param.type.name)) return false;
		// An array/view param's Type NAME is its element type (`int[]` is
		// name "int" + is_array), so the SIMPLE_TYPES check above doesn't
		// exclude it — but the inline path parks params in callee-saved
		// registers as scalars, which corrupts pointer-passed aggregates.
		if (param.type.is_array || param.type.is_view) return false;
		if (param.type.is_ref) return false;
		if (param.is_moved) return false;
		if (param.declaration === "var") return false;
	}
	// A body that redeclares a param name (shadowing) can't be inlined: the
	// inline path parks params in callee-saved registers that emit paths
	// consult BEFORE slot-resident locals, so the shadowed local's reads
	// would grab the param register instead (standalone callers resolve the
	// same shapes correctly — this is the known name-keyed divergence class).
	const param_names = new Set(func.params.map((p) => p.name));
	if (declares_any_name(func.statements, param_names)) return false;

	// Same array/view exclusion for the return: it rides pointer conventions
	// (and e.g. an array-literal return emits data the inline path can't
	// splice — a bare `1, 2, 3` line reached the assembler).
	if (func.return_type?.is_array || func.return_type?.is_view) return false;
	if (func.return_type && func.return_type.name && !SIMPLE_TYPES.includes(func.return_type.name)) {
		return false;
	}

	return is_leaf(func.statements);
}

/** Whether any `declare` node in the subtree names one of `names` (param
 *  shadowing). */
function declares_any_name(
	node: BaseNode | BaseNode[] | null | undefined,
	names: Set<string>,
): boolean {
	if (!node) return false;
	if (Array.isArray(node)) {
		for (const item of node) {
			if (declares_any_name(item, names)) return true;
		}
		return false;
	}
	if (typeof node !== "object") return false;
	const any_node = node as any;
	if (any_node.node_type === "declare" && names.has(any_node.name as string)) return true;
	for (const key of Object.keys(any_node)) {
		if (key === "parent" || key === "scope") continue;
		const val = any_node[key];
		if (val && typeof val === "object" && typeof val.node_type === "string") {
			if (declares_any_name(val as BaseNode, names)) return true;
		} else if (Array.isArray(val)) {
			if (declares_any_name(val as BaseNode[], names)) return true;
		}
	}
	return false;
}

function is_leaf(statements: BaseNode[]): boolean {
	const visited = new Set<object>();
	for (const stmt of statements) {
		if (!check_leaf(stmt, visited)) return false;
	}
	return true;
}

function check_leaf(node: BaseNode | undefined, visited: Set<object>): boolean {
	if (!node || typeof node !== "object") return true;
	if (visited.has(node)) return true;
	visited.add(node);

	const nt = (node as any).node_type;
	if (nt === "func_call") return false;
	if (nt === "access" && (node as any).access?.node_type === "access_func") return false;
	if (nt === "func") return false;

	for (const key of Object.keys(node)) {
		if (key === "node_type" || key === "start" || key === "type" || key === "scope") continue;
		const child = (node as any)[key];
		if (Array.isArray(child)) {
			for (const item of child) {
				if (item && typeof item === "object" && (item as any).node_type) {
					if (!check_leaf(item as BaseNode, visited)) return false;
				}
			}
		} else if (child && typeof child === "object" && (child as any).node_type) {
			if (!check_leaf(child as BaseNode, visited)) return false;
		}
	}

	return true;
}
