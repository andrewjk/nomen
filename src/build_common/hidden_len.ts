import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";

/**
 * Indices of a call's DECLARED arguments whose callee parameter carries the
 * hidden string-length companion (`ParameterNode.hidden_len`, stamped by the
 * post-check `stamp_hidden_string_lens` pass). The backends append one
 * companion argument right after each such argument — `long _<name>_len` on
 * C, the next AAPCS slot on aarch64 — and the hoist scan treats these args
 * like `.length` reads so a loop-invariant strlen temp covers them.
 *
 * Resolution comes from the checker's `resolved_function` stamp (exact for
 * overloads and monomorphized copies); an unstamped call site (synthesized
 * nodes, indirect func-value calls) yields no companions, which matches the
 * qualification pass — those callees are never stamped `hidden_len`.
 */
export default function callee_hidden_len_indices(
	call: FunctionCallNode | AccessFunctionCallNode,
): number[] {
	const func = call.resolved_function;
	if (!func) return [];
	const self_offset = func.params[0]?.is_self_param ? 1 : 0;
	const out: number[] = [];
	for (let i = 0; i < call.params.length; i++) {
		if (func.params[i + self_offset]?.hidden_len) out.push(i);
	}
	return out;
}
