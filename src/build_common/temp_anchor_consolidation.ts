import type StructNode from "../nodes/StructNode.ts";

/**
 * Shared OWNERSHIP decision for hoisted call-temporary consolidation.
 *
 * When a class-typed variable captures the result of a call that also
 * received a same-type class temporary as a non-mov arg (the hoisted
 * `_param_N` for e.g. `Box(5)`), the callee may return that very instance
 * (e.g. `return x ?? fallback`). The result variable supersedes the
 * temporary: both backends must consolidate to a single owner or auto-free
 * double-frees.
 *
 * This returns WHICH parameter temporaries are superseded; each backend
 * performs its own action on its own bookkeeping (C removes the temporary
 * from `scoped_declarations`, aarch64 marks the anchor slot moved). Keeping
 * the decision here guarantees the two backends can't diverge on the
 * predicate again — this exact logic was maintained twice and drifted.
 */
export function superseded_param_temp_names(
	table: { structs: StructNode[] },
	call_node: { node_type?: string; params?: any[]; mov_param_indices?: number[] } | undefined,
	result_type_name: string | undefined,
): string[] {
	if (!call_node || call_node.node_type !== "func_call" || !call_node.params) return [];
	if (!result_type_name) return [];
	const is_class = !!table.structs.find((s) => s.name === result_type_name && s.is_class);
	if (!is_class) return [];
	const names: string[] = [];
	for (let i = 0; i < call_node.params.length; i++) {
		const p = call_node.params[i];
		if (p?.node_type !== "value") continue;
		if (call_node.mov_param_indices?.includes(i)) continue;
		const pname = p.value as string;
		// Only hoisted call temporaries (_param_N) — plain variables may
		// still be used after the call and must keep their own cleanup.
		if (typeof pname !== "string" || !pname.startsWith("_param_")) continue;
		if ((p as { type?: { name?: string } }).type?.name !== result_type_name) continue;
		names.push(pname);
	}
	return names;
}
