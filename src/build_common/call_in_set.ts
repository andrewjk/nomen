import type FunctionCallNode from "../nodes/FunctionCallNode.ts";

/**
 * Whether a callee-classification set (heap/borrow-returning function
 * labels) contains this call's target. The sets are keyed by EMISSION labels
 * (`emission_label`): the checker-assigned uniquified label for functions
 * nested inside another body, else the source name. A call's resolved
 * FunctionNode carries that label; struct constructors / methods never have
 * one, so the plain name is the fallback.
 */
export default function call_in_set(set: Set<string> | undefined, call: FunctionCallNode): boolean {
	if (!set) return false;
	const resolved = call.resolved_function;
	if (resolved?.label_name && set.has(resolved.label_name.replace(/#/g, ""))) {
		return true;
	}
	return set.has(call.name.replace(/#/g, ""));
}
