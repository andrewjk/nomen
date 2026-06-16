import type BaseNode from "../../nodes/BaseNode.ts";

/**
 * Check if an item is visible from the current access scope.
 * - If item is pub, it's visible everywhere
 * - If item is private, it's visible only within its declaring scope
 *   or descendant scopes (checked by walking the stack)
 */
export default function is_visible(
	declaring_scope: BaseNode | undefined,
	visibility: "pub" | "private",
	access_scope: BaseNode,
	stack: BaseNode[],
): boolean {
	if (visibility === "pub") return true;
	if (!declaring_scope) return true;
	// Private: access_scope must be declaring_scope or a descendant
	for (const node of stack) {
		if (node === declaring_scope) return true;
		if ((node as any).scope === declaring_scope) return true;
	}
	return access_scope === declaring_scope;
}
