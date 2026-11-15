import BaseNode from "./BaseNode.ts";

/** Whether `value` is an AST node (carries a string `node_type`). */
export function is_ast_node(value: unknown): value is BaseNode {
	return (
		!!value &&
		typeof value === "object" &&
		"node_type" in value &&
		typeof (value as { node_type: unknown }).node_type === "string"
	);
}

/**
 * The direct AST children of `node`: node-valued fields and arrays of nodes.
 *
 * Case lists (`SwitchNode.cases`, `MatchNode.cases`) hold plain
 * `{ condition, branch }` wrapper objects rather than BaseNodes, so their
 * node-valued fields are unwrapped here too — a generic walk must never lose
 * the subtree under a switch/match case (a condition or body living there is
 * invisible to any walker that only descends into node-shaped values).
 *
 * `skip` names fields to omit; it defaults to the `parent`/`scope` back-refs.
 */
const DEFAULT_SKIP = new Set(["parent", "scope"]);

export function child_nodes(node: BaseNode, skip?: string[]): BaseNode[] {
	const out: BaseNode[] = [];
	// The default skip set is shared (the common case — every generic AST
	// walk); a custom skip list still gets its own Set.
	const skipped = skip ? new Set(skip) : DEFAULT_SKIP;
	// for-in over class instances enumerates the own fields (methods sit on
	// the non-enumerable prototype), and avoids the Object.keys array
	// allocation per visited node.
	for (const key in node) {
		if (skipped.has(key)) continue;
		const value = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (is_ast_node(item)) out.push(item);
				else unwrap_wrapper(item, out);
			}
		} else if (is_ast_node(value)) {
			out.push(value);
		} else {
			unwrap_wrapper(value, out);
		}
	}
	return out;
}

/** Collect the node-valued fields of a plain (non-BaseNode) wrapper object. */
function unwrap_wrapper(value: unknown, out: BaseNode[]): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	for (const key of Object.keys(value)) {
		const inner = (value as Record<string, unknown>)[key];
		if (is_ast_node(inner)) out.push(inner);
	}
}
