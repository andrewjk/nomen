import { SIMPLE_TYPES } from "../../built_in_types.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import { child_nodes } from "../../nodes/child_nodes.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";

const MAX_STATEMENTS = 15;

/** Auto method inlining (ASM_PLAN_7 tranche 7). DEFAULT OFF: the splice
 *  of unmarked small methods segfaults on the JsonTree receipt shape
 *  (every set-kind / get-child splice crashes independently — see
 *  FOLLOWUP.md), so the mechanism ships kill-switch-only for A/B work
 *  until that class is root-caused. OFF restores exactly the explicit-
 *  `inline`-only dispatch. */
let auto_method_inline_on = false;

export function auto_method_inline_enabled(): boolean {
	return auto_method_inline_on;
}

export function set_auto_method_inline_enabled(enabled: boolean): void {
	auto_method_inline_on = enabled;
}

const MAX_AUTO_METHOD_STATEMENTS = 3;
const MAX_AUTO_METHOD_PARAMS = 3;

/**
 * ensure/grow/clear-shaped methods (ASM_PLAN_7 tranche 7): small real
 * bodies the method-inline path can splice WITHOUT the explicit `inline`
 * marker — killing the per-call `bl` + ABI marshal at hot call sites
 * (the pidigits receipt: 282 samples in `BigInt_ensure` as a real call
 * per D2 iteration). Deliberately NARROWER than the user-marked path's
 * freedom: no raw statements (raw-only methods keep their naked-inline
 * contract), a tight statement budget, scalar params beside self, and a
 * scalar-or-void return. The standalone body is still emitted — trait
 * dispatch, method values, and overflow-arg call sites keep taking the
 * `bl`, so nothing here may skip emission.
 */
export function is_auto_inline_method(func: FunctionNode): boolean {
	if (!auto_method_inline_on) return false;
	if (!func.has_body) return false;
	if (func.is_inline) return false; // explicit — the call sites already select it
	if (func.statements.length === 0 || func.statements.length > MAX_AUTO_METHOD_STATEMENTS) {
		return false;
	}
	if (func.returns_move) return false;
	if (func.statements.some((s) => s.node_type === "raw")) return false;
	// The ensure/clear shape: self plus at most a couple of scalars. A
	// `ref self` receiver (mutable-through-the-caller's-instance) is the
	// user-inline path's proven surface (BigInt.set); wide param lists are
	// not — the set_leaf_kind receipt spliced a 7-param method whose param
	// reads fell back to global-address emission.
	if (func.params.length > MAX_AUTO_METHOD_PARAMS) return false;

	for (const param of func.params) {
		// The splice's self parking is a struct-receiver contract: a scalar
		// receiver (`char.is_digit` — the receiver is a bare w-register
		// value, and `char` is no struct at all) or a fat string (a
		// ptr+len pair — the at_or receipt) mis-splices. Struct receivers
		// only.
		if (param.is_self_param) {
			if (!param.type?.name || param.type.name === "string") return false;
			if (SIMPLE_TYPES.includes(param.type.name)) return false;
			continue;
		}
		if (param.is_variadic || param.is_variadic_tuple) return false;
		if (!SIMPLE_TYPES.includes(param.type.name)) return false;
		if (param.type.is_array || param.type.is_view) return false;
		if (param.type.is_ref) return false;
		if (param.is_moved) return false;
		if (param.declaration === "var") return false;
	}
	// Param shadowing corrupts the inline path the same way it corrupts
	// the flat path (params park in registers that shadowed locals would
	// grab) — a body redeclaring a param name refuses.
	const param_names = new Set(func.params.filter((p) => !p.is_self_param).map((p) => p.name));
	if (declares_any_name(func.statements, param_names)) return false;
	if (func.return_type?.is_array || func.return_type?.is_view) return false;
	if (func.return_type?.name && !SIMPLE_TYPES.includes(func.return_type.name)) return false;

	return true;
}

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
	for (const child of child_nodes(node)) {
		collect_function_statements(child, counts, defs);
	}
}

function is_inline_candidate(func: FunctionNode): boolean {
	if (!func.has_body) return false;
	if (func.is_inline) return false;
	if (func.statements.length === 0 || func.statements.length > MAX_STATEMENTS) return false;
	if (func.returns_move) return false;
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
	for (const child of child_nodes(any_node)) {
		if (declares_any_name(child as BaseNode, names)) return true;
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

	for (const child of child_nodes(node)) {
		if (!check_leaf(child as BaseNode, visited)) return false;
	}

	return true;
}
