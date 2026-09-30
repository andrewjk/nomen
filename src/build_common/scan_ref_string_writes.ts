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
 * Only DIRECT statements qualify: a store nested in a branch/loop may not
 * execute, and a record over the pre-call value would free it at the caller's
 * scope exit (possibly rodata — an invalid free). Memoized on the function
 * node; forwarding cycles are cut by a visited set (the cycle member's own
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
	const tracked = new Map<string, Set<string>>();
	for (const param of func.params ?? []) {
		if (param.is_self_param) continue;
		if (!(param.is_ref || param.type.is_ref)) continue;
		if (param.type.is_array || param.type.is_view) continue;
		const fields = ref_param_writable_fields(param.type.name, structs);
		if (fields.size) tracked.set(param.name, fields);
	}
	if (tracked.size) {
		scan_function(func, tracked, structs, result, new Set<FunctionNode>());
	}
	return result;
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

function scan_function(
	func: FunctionNode,
	tracked: Map<string, Set<string>>,
	structs: StructNode[],
	result: Map<string, Set<string>>,
	visiting: Set<FunctionNode>,
): void {
	visiting.add(func);
	for (const stmt of func.statements ?? []) {
		// A direct `param.<field> = <expr>` store.
		if (stmt.node_type === "assign") {
			const lhs = (stmt as unknown as { left_value?: BaseNode }).left_value;
			if (lhs?.node_type === "access") {
				const access = lhs as AccessNode;
				if (access.access.node_type === "access_field" && access.target.node_type === "value") {
					const name = (access.target as { value?: string }).value ?? "";
					const fields = tracked.get(name);
					const field = (access.access as AccessFieldNode).name ?? "";
					if (fields?.has(field)) {
						if (!result.has(name)) result.set(name, new Set<string>());
						result.get(name)!.add(field);
					}
				}
			}
			continue;
		}
		// A forwarded call: `helper(param, ...)` / `recv.helper(param, ...)`
		// whose callee takes the param as its own `ref` value-struct param —
		// merge the callee's scan for that param.
		const call = ref_forward_call(stmt);
		if (!call) continue;
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
			// Cycles: skip a callee currently being scanned (its memo is not
			// final yet); the memo stamp was set up front, so a finished or
			// in-progress callee never re-enters scan_function here.
			if (visiting.has(callee)) continue;
			const callee_writes = scan_ref_param_string_field_writes(callee, structs).get(
				callee_param.name,
			);
			if (!callee_writes?.size) continue;
			if (!result.has(arg_name)) result.set(arg_name, new Set<string>());
			const mine = result.get(arg_name)!;
			for (const field of callee_writes) {
				if (my_fields.has(field)) mine.add(field);
			}
		}
	}
	visiting.delete(func);
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
