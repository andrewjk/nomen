import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";

/**
 * True when the expression is the zero-argument `.copy()` call the checker
 * resolved to a fresh-value deep copy — the SYNTHESIZED struct copy
 * (`is_synthesized_copy`; a user-written `copy` never carries the marker) or
 * the List/Map/Set library copy (the receiver's stamped type names the
 * container; a user struct named `List` cannot exist).
 *
 * The call borrows its receiver and returns a FRESH, independently-owned
 * value: assignment reclamation must treat it like a fresh constructor
 * (reclaim the displaced value, keep the variable registered), never as an
 * alias of the receiver's buffer — and never reclaim the displaced value
 * BEFORE the call when the receiver is the assigned variable itself.
 */
export default function is_fresh_copy_call(rhs: BaseNode): boolean {
	if (rhs.node_type !== "access") return false;
	const access = rhs as AccessNode;
	if (access.access.node_type !== "access_func") return false;
	const af = access.access as AccessFunctionCallNode;
	if (af.name !== "copy" || af.params.length !== 0) return false;
	if (af.resolved_function?.is_synthesized_copy) return true;
	const target = access.target;
	if (target.node_type !== "value") return false;
	const tname = (target as ValueNode).type?.name ?? af.resolved_function?.return_type?.name ?? "";
	return tname === "List" || tname === "Map" || tname === "Set";
}
