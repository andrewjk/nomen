import type FunctionNode from "./FunctionNode.ts";

/**
 * The checker stamps each resolved call with the concrete FunctionNode
 * (plain function, constructor, or monomorphized copy) so build-time passes
 * can consult callee-signature facts — notably the hidden string-length
 * companion params (`ParameterNode.hidden_len`).
 *
 * The reference is stored NON-ENUMERABLE on purpose: AST nodes are walked
 * reflectively all over the compiler (`Object.keys` loops in the hoist
 * scanner, raw-substitution, ownership scans, …) and a node-valued field
 * would make every one of them recurse into the CALLEE's body — misfiring
 * invalidation scans and letting monomorphization substitutions mutate
 * shared originals. Non-enumerable keeps the pointer invisible to all of
 * them (and to JSON snapshots) while staying a plain property read for the
 * consumers that want it.
 */
type WithResolvedFunction = { resolved_function?: FunctionNode };

export function set_resolved_function(
	node: WithResolvedFunction,
	func: FunctionNode | undefined,
): void {
	Object.defineProperty(node, "resolved_function", {
		value: func,
		enumerable: false,
		writable: true,
		configurable: true,
	});
}
