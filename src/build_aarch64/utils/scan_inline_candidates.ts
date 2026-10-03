import { SIMPLE_TYPES } from "../../built_in_types.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import { child_nodes } from "../../nodes/child_nodes.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";

const MAX_STATEMENTS = 15;

/** Auto method inlining (ASM_PLAN_7 tranche 7), default ON: LEAF bodies
 *  (no calls), no T-generic callees, struct receivers, ≤3 statements and
 *  params. Measured (n=4000/1500-scale benches, interleaved best-of):
 *  spectral-norm −53%, knucleotide −26%, json-serde/fannkuch ~−1%,
 *  neutral elsewhere. OFF restores exactly the explicit-`inline`-only
 *  dispatch. */
let auto_method_inline_on = true;

export function auto_method_inline_enabled(): boolean {
	return auto_method_inline_on;
}

export function set_auto_method_inline_enabled(enabled: boolean): void {
	auto_method_inline_on = enabled;
}

/** Call-bearing auto inlining (the ASM_PLAN_7 follow-up), default ON:
 *  admits auto candidates whose bodies CALL, when every call splices
 *  through (the callee is itself inline-spliceable under the same rules,
 *  transitively, depth-capped) or is an `extern` (a `bl` either way —
 *  the grow_int receipt: `ensure`→`grow_int` leaves only realloc/memset
 *  bls on the cold path, so the hot path's call disappears entirely).
 *  The original +52–62% regression receipt for call-bearing splices was
 *  the leaked `nir_site_allocs` clear in build_inline_method (fixed:
 *  the splice stripped the rest of the host function of its planned
 *  registers — slot-resident loops, pidigits +40% at n=20000), not an
 *  intrinsic cost. OFF restores exactly the leaf-only admission. */
let auto_calling_inline_on = true;

export function auto_calling_inline_enabled(): boolean {
	return auto_calling_inline_on;
}

export function set_auto_calling_inline_enabled(enabled: boolean): void {
	auto_calling_inline_on = enabled;
}

const MAX_AUTO_METHOD_STATEMENTS = 3;
const MAX_AUTO_METHOD_PARAMS = 3;
const MAX_AUTO_CALLING_STATEMENTS = 10;
const MAX_AUTO_SPLICE_DEPTH = 2;

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
 *
 * `depth` is the number of inline splices already open at the dispatch
 * site (build_access_node passes `active_splices.size`); the admission
 * recursion for a candidate's callees runs at `depth + 1`, so a chain
 * deeper than MAX_AUTO_SPLICE_DEPTH is refused everywhere — the plan-time
 * and emit-time verdicts then agree.
 */
export function is_auto_inline_method(func: FunctionNode, depth = 0): boolean {
	if (!auto_method_inline_on) return false;
	if (!func.has_body) return false;
	if (func.is_inline) return false; // explicit — the call sites already select it
	const calls = body_calls(func.statements);
	// The tight 3-statement leaf budget is the depth-0 dispatch shape
	// (tranche 7's receipts). A CHAIN LINK (depth > 0 — admitted only as
	// the callee of an admitted call-bearing candidate) rides the wider
	// budget whether or not its own body calls: a call-free grow_to-shaped
	// body is exactly as spliceable as a call-bearing one.
	const max_statements =
		calls || depth > 0 ? MAX_AUTO_CALLING_STATEMENTS : MAX_AUTO_METHOD_STATEMENTS;
	if (func.statements.length === 0 || func.statements.length > max_statements) {
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
		// A nullable scalar param rides the (value, flag) pair ABI and a
		// nullable scalar return the x8 sret buffer; the inline splice parks
		// params in callee-saved registers as plain scalars, which corrupts
		// both. Keep such functions on the real `bl` path.
		if (param.type.is_nullable) return false;
	}
	// Param shadowing corrupts the inline path the same way it corrupts
	// the flat path (params park in registers that shadowed locals would
	// grab) — a body redeclaring a param name refuses.
	const param_names = new Set(func.params.filter((p) => !p.is_self_param).map((p) => p.name));
	if (declares_any_name(func.statements, param_names)) return false;
	if (func.return_type?.is_array || func.return_type?.is_view) return false;
	if (func.return_type?.is_nullable) return false;
	if (func.return_type?.name && !SIMPLE_TYPES.includes(func.return_type.name)) return false;

	// LEAF: the body may not call anything — admitted unconditionally
	// (the original tranche-7 shape). A body that calls admits only under
	// the call-bearing cost model: every call splices through (the callee
	// is itself admitted at the next depth, or a user-`inline` method the
	// splice path already handles) or is an `extern` (a `bl` either way).
	// The ensure→grow_int chain then expands with ZERO bls on the hot
	// path — grow_int's `if self.cap >= needed return` fast path inlines
	// into the caller's loop and only realloc/memset stay, on the cold
	// path. The original +52–62% regression for this shape was the leaked
	// nir_site_allocs clear in build_inline_method (see there), not an
	// intrinsic cost.
	if (!calls) return true;
	if (!auto_calling_inline_on) return false;
	if (depth >= MAX_AUTO_SPLICE_DEPTH) return false;
	return body_calls_splice_through(func.statements, depth);
}

/** Whether the subtree contains any call (method or function). */
function body_has_call(node: BaseNode | BaseNode[] | null | undefined): boolean {
	return body_calls(node);
}

function body_calls(node: BaseNode | BaseNode[] | null | undefined): boolean {
	if (!node) return false;
	if (Array.isArray(node)) {
		for (const item of node) {
			if (body_calls(item)) return true;
		}
		return false;
	}
	if (typeof node !== "object") return false;
	const nt = (node as any).node_type;
	if (nt === "access_func" || nt === "func_call") return true;
	for (const child of child_nodes(node)) {
		if (body_calls(child as BaseNode)) return true;
	}
	return false;
}

/**
 * The call-bearing cost model: every call in the subtree must either be
 * an `extern` (a `bl` whether the host splices or not — the expansion
 * changes nothing about the call count) or splice through — the callee is
 * a user-`inline` method (the splice path already handles call-bearing
 * user bodies) or itself admitted as an auto candidate at `depth + 1`.
 * Anything else keeps the host on the real `bl` path: expanding a call
 * whose callee cannot splice replaces one `bl` with the same `bl` plus
 * parking, which is the shape the tranche-7 receipts measured as a loss.
 *
 * `resolved_function` is the checker's stamp — present on every call the
 * checker accepted, and clone_node preserves it. A call without one is
 * refused (conservative).
 */
function body_calls_splice_through(
	node: BaseNode | BaseNode[] | null | undefined,
	depth: number,
): boolean {
	if (!node) return true;
	if (Array.isArray(node)) {
		for (const item of node) {
			if (!body_calls_splice_through(item, depth)) return false;
		}
		return true;
	}
	if (typeof node !== "object") return true;
	const any_node = node as any;
	const nt = any_node.node_type as string;
	if (nt === "access_func" || nt === "func_call") {
		const callee = any_node.resolved_function as FunctionNode | undefined;
		if (!callee) return false;
		if (callee.is_extern) return true;
		if (callee.is_inline) return true;
		return is_auto_inline_method(callee, depth + 1);
	}
	for (const child of child_nodes(node)) {
		if (!body_calls_splice_through(child as BaseNode, depth)) return false;
	}
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
		// A nullable scalar param rides the (value, flag) pair ABI and a
		// nullable scalar return the x8 sret buffer; the inline splice parks
		// params in callee-saved registers as plain scalars, which corrupts
		// both. Keep such functions on the real `bl` path.
		if (param.type.is_nullable) return false;
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
	if (func.return_type?.is_nullable) return false;
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
