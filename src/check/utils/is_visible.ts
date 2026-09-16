import type BaseNode from "../../nodes/BaseNode.ts";

/** Whether a node was declared in the appended System library source. */
function node_is_library(node: BaseNode | undefined): boolean {
	return !!(node as { is_library?: boolean } | undefined)?.is_library;
}

/**
 * Check if an item is visible from the current access scope.
 * - If item is pub, it's visible everywhere
 * - If item is internal, it's visible only within the declaring module/library
 *   (the access is trusted when both sides sit on the same side of the System
 *   library boundary — or when `allow_internal` opts a build into trusted mode)
 * - If item is private, it's visible only within its declaring scope
 *   or descendant scopes (checked by walking the stack)
 */
export default function is_visible(
	declaring_scope: BaseNode | undefined,
	visibility: "pub" | "private" | "internal",
	access_scope: BaseNode,
	stack: BaseNode[],
	declaring_is_library = false,
	allow_internal = false,
): boolean {
	if (visibility === "pub") return true;
	if (visibility === "internal") {
		if (allow_internal) return true;
		const access_is_library = stack.some((node) => node_is_library(node));
		return declaring_is_library === access_is_library;
	}
	if (!declaring_scope) return true;
	// Private: access_scope must be declaring_scope or a descendant
	for (const node of stack) {
		if (node === declaring_scope) return true;
		if ((node as any).scope === declaring_scope) return true;
	}
	return access_scope === declaring_scope;
}
