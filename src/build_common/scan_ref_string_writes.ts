import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import { direct_string_fields } from "./has_string_fields.ts";

/**
 * The plain `string` fields of `func`'s `ref` value-struct parameters that the
 * function stores through with a DIRECT top-level statement — transitively
 * through top-level calls that forward the same param as their own `ref`
 * argument (callees resolved via the checker's `resolved_function` stamps).
 *
 * Both backends' string-field store paths strdup every non-heap RHS into an
 * owned copy before storing (a field is never a borrow once stored), so a
 * definitely-executed store leaves the field heap-owned. That is the fact a
 * CALL SITE transfers onto the caller's `heap_string_fields` records (the
 * add-direction mirror of `drop_self_written_string_field_records`): the
 * callee's own records are scope-local and die at return, so without the
 * transfer the stored copy leaks.
 *
 * Only DIRECT statements qualify for the plain transfer: a store nested in a
 * branch/loop may not execute, and a record over the pre-call value would
 * free it at the caller's scope exit (possibly rodata — an invalid free).
 * Those CONDITIONAL stores are reported separately
 * (scan_ref_param_string_field_may_writes): the callee's function builder
 * emits an ENTRY DUP for each of them (`field = strdup(field)` at function
 * entry, recorded), which makes the field heap-owned on EVERY path and the
 * may-store record sound to transfer. Memoized on the function node;
 * forwarding cycles are cut by a visited set (the cycle member's own
 * contribution is skipped, bounded-leak).
 */
export default function scan_ref_param_string_field_writes(
	func: FunctionNode,
	structs: StructNode[],
): Map<string, Set<string>> {
	const stamp = func as unknown as {
		_ref_param_string_field_writes?: Map<string, Set<string>>;
	};
	if (stamp._ref_param_string_field_writes) return stamp._ref_param_string_field_writes;
	const result = new Map<string, Set<string>>();
	stamp._ref_param_string_field_writes = result;
	// Tracked ref params: name -> the struct's writable plain string fields.
	const tracked = tracked_ref_params(func, structs);
	if (tracked.size) {
		scan_top_level(func.statements ?? [], tracked, structs, result);
	}
	return result;
}

/**
 * The CONDITIONAL (`may-executed`) ref-param field stores: direct stores
 * nested in if/else branches, switch cases, and loop bodies. Forwarded
 * calls from a nested position are deliberately EXCLUDED: a helper's store
 * builds with its own (fresh) record set, so it cannot reclaim the
 * displaced entry-dup — dup'ing for a forwarded store would trade the
 * old bounded leak for a new one. Those chains keep the documented
 * bounded-leak posture (the stored copy leaks, never an invalid free).
 * The function builder entry-dups these fields (see
 * ref_param_entry_dup_fields), making the may-store record transferable.
 */
export function scan_ref_param_string_field_may_writes(
	func: FunctionNode,
	structs: StructNode[],
): Map<string, Set<string>> {
	const stamp = func as unknown as {
		_ref_param_string_field_may_writes?: Map<string, Set<string>>;
	};
	if (stamp._ref_param_string_field_may_writes) return stamp._ref_param_string_field_may_writes;
	const result = new Map<string, Set<string>>();
	stamp._ref_param_string_field_may_writes = result;
	const tracked = tracked_ref_params(func, structs);
	if (tracked.size) {
		scan_nested(func.statements ?? [], tracked, result);
	}
	return result;
}

/**
 * The fields a function's builder must ENTRY DUP: the conditional
 * (may-executed) ref-param string-field stores that are NOT also
 * definitely-executed (a must-store already leaves the field heap-owned on
 * every path — dup'ing it too would just add a pointless strdup per call).
 * The dup runs at callee entry on both backends and records the field, so a
 * call site may transfer these as heap records soundly.
 */
export function ref_param_entry_dup_fields(
	func: FunctionNode,
	structs: StructNode[],
): Map<string, Set<string>> {
	const must = scan_ref_param_string_field_writes(func, structs);
	const may = scan_ref_param_string_field_may_writes(func, structs);
	const result = new Map<string, Set<string>>();
	for (const [param, fields] of may) {
		const dup = new Set<string>();
		for (const field of fields) {
			if (!must.get(param)?.has(field)) dup.add(field);
		}
		if (dup.size) result.set(param, dup);
	}
	return result;
}

/** The tracked ref params of `func`: name -> writable plain string fields. */
function tracked_ref_params(func: FunctionNode, structs: StructNode[]): Map<string, Set<string>> {
	const tracked = new Map<string, Set<string>>();
	for (const param of func.params ?? []) {
		if (param.is_self_param) continue;
		if (!(param.is_ref || param.type.is_ref)) continue;
		if (param.type.is_array || param.type.is_view) continue;
		const fields = ref_param_writable_fields(param.type.name, structs);
		if (fields.size) tracked.set(param.name, fields);
	}
	return tracked;
}

/** The writable plain string fields of the value struct `type_name` resolves
 *  to, or the empty set (non-struct, class, or no string fields). */
function ref_param_writable_fields(
	type_name: string | undefined,
	structs: StructNode[],
): Set<string> {
	if (!type_name) return new Set<string>();
	const struct = structs.find((s) => s.name === type_name && !s.is_simple_type && !s.is_class);
	if (!struct) return new Set<string>();
	return new Set(direct_string_fields(struct).map((f) => f.name));
}

/**
 * The top-level (definitely-executed) walk: direct `param.field = …`
 * statements and top-level forwarded calls only — nothing nested.
 */
function scan_top_level(
	statements: BaseNode[],
	tracked: Map<string, Set<string>>,
	structs: StructNode[],
	result: Map<string, Set<string>>,
): void {
	for (const stmt of statements) {
		if (stmt.node_type === "assign") {
			record_direct_store(stmt, tracked, result);
			continue;
		}
		const call = ref_forward_call(stmt);
		if (call) {
			merge_forwarded(call, tracked, structs, result);
		}
	}
}

/**
 * The nested walk: direct stores at ANY depth below the top level are
 * may-stores. Forwarded calls are skipped everywhere (their contributions
 * would need cross-function displaced-value knowledge the callee's fresh
 * record set cannot carry — see the may-scan doc).
 */
function scan_nested(
	statements: BaseNode[],
	tracked: Map<string, Set<string>>,
	result: Map<string, Set<string>>,
): void {
	for (const stmt of statements) {
		if (stmt.node_type === "assign") {
			record_direct_store(stmt, tracked, result);
			continue;
		}
		for (const nested of nested_statement_lists(stmt)) {
			scan_nested(nested, tracked, result);
		}
	}
}

/** Record a direct `param.<field> = …` store into `result`. */
function record_direct_store(
	stmt: BaseNode,
	tracked: Map<string, Set<string>>,
	result: Map<string, Set<string>>,
): void {
	const lhs = (stmt as unknown as { left_value?: BaseNode }).left_value;
	if (lhs?.node_type !== "access") return;
	const access = lhs as AccessNode;
	if (access.access.node_type !== "access_field" || access.target.node_type !== "value") return;
	const name = (access.target as { value?: string }).value ?? "";
	const fields = tracked.get(name);
	const field = (access.access as AccessFieldNode).name ?? "";
	if (!fields?.has(field)) return;
	if (!result.has(name)) result.set(name, new Set<string>());
	result.get(name)!.add(field);
}

/** Merge a forwarded call's callee stores for the forwarded param: the
 *  callee's MUST stores at a top-level position. */
function merge_forwarded(
	call: [FunctionNode, BaseNode[]],
	tracked: Map<string, Set<string>>,
	structs: StructNode[],
	result: Map<string, Set<string>>,
): void {
	const [callee, args] = call;
	const non_self_params = (callee.params ?? []).filter((p) => !p.is_self_param);
	for (let i = 0; i < args.length && i < non_self_params.length; i++) {
		const arg = args[i];
		if (arg?.node_type !== "value") continue;
		const arg_name = (arg as { value?: string }).value ?? "";
		const my_fields = tracked.get(arg_name);
		if (!my_fields) continue;
		const callee_param = non_self_params[i];
		if (!(callee_param.is_ref || callee_param.type.is_ref)) continue;
		// Cycle cut: both scans memoize (pre-set stamps), so a forwarding
		// cycle re-enters the pre-set (partial) memo and terminates — the
		// cycle member's contribution is skipped, bounded-leak.
		const source = scan_ref_param_string_field_writes(callee, structs).get(callee_param.name);
		if (!source?.size) continue;
		if (!result.has(arg_name)) result.set(arg_name, new Set<string>());
		const mine = result.get(arg_name)!;
		for (const field of source) {
			if (my_fields.has(field)) mine.add(field);
		}
	}
}

/** The statement lists nested inside `stmt` (branch bodies, loop bodies) —
 *  the same walk scan_reassigned_vars uses. */
function nested_statement_lists(stmt: BaseNode): BaseNode[][] {
	const branch_of = (b: unknown): BaseNode[] =>
		(b as { statements?: BaseNode[] })?.statements ?? [];
	const lists: BaseNode[][] = [];
	if (stmt.node_type === "while" || stmt.node_type === "for") {
		const nested = (stmt as unknown as { statements: BaseNode[] }).statements;
		if (nested) lists.push(nested);
		return lists;
	}
	if (stmt.node_type === "if") {
		const n = stmt as unknown as { if_branch?: unknown; else_branch?: unknown };
		if (n.if_branch) lists.push(branch_of(n.if_branch));
		if (n.else_branch) lists.push(branch_of(n.else_branch));
		return lists;
	}
	if (stmt.node_type === "switch" || stmt.node_type === "match") {
		const n = stmt as unknown as {
			cases?: { branch?: unknown }[];
			else_branch?: unknown;
		};
		for (const c of n.cases ?? []) {
			if (c.branch) lists.push(branch_of(c.branch));
		}
		if (n.else_branch) lists.push(branch_of(n.else_branch));
		return lists;
	}
	return lists;
}

/**
 * The forwarded-call shape of a top-level statement: a resolved free-function
 * call or method call, with its argument list (the receiver is NOT included).
 */
function ref_forward_call(stmt: BaseNode): [FunctionNode, BaseNode[]] | undefined {
	if (stmt.node_type === "func_call") {
		const call = stmt as unknown as { resolved_function?: FunctionNode; params?: BaseNode[] };
		if (!call.resolved_function) return undefined;
		return [call.resolved_function, call.params ?? []];
	}
	if (stmt.node_type === "access") {
		const access = stmt as AccessNode;
		if (access.access.node_type !== "access_func") return undefined;
		const func_node = (access.access as unknown as AccessFunctionCallNode).resolved_function;
		if (!func_node) return undefined;
		return [func_node, (access.access as unknown as { params: BaseNode[] }).params ?? []];
	}
	return undefined;
}
