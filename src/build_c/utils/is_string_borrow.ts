import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";

/**
 * Whether a value node denotes a BORROWED string — a pointer into storage the
 * receiver does not own (an array element accessed via `.at()`/`.first()`, or
 * `init.args.at(n)` which points into the C runtime's `argv`). Borrowed
 * strings must NOT be freed by auto_free or by reassignment: freeing them
 * reclaims memory owned by the container (or argv), crashing with
 * "pointer being freed was not allocated". Mirrors aarch64's `heap_strings`
 * ownership tracking, which only frees freshly-allocated strings.
 */
export default function is_string_borrow(node: BaseNode | undefined): boolean {
	if (!node || node.node_type !== "access") return false;
	const access = (node as AccessNode).access;
	if (access.node_type !== "access_func") return false;
	const func = access as AccessFunctionCallNode;
	// `.at()`/`.first()` on an array return a borrowed element pointer. A
	// method with `owned_return` (mov out T) produces a fresh allocation, not
	// a borrow, so it must remain owned.
	return (func.name === "at" || func.name === "first") && !func.owned_return;
}
