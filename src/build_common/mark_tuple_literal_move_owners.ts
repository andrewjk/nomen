import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";

/**
 * A tuple-literal constructor call (`[move t, move c]` lowered to
 * `_Tuple_.._init(&t, &c)`) copies its fields BY POINTER, and a `move`
 * element transfers ownership: the source local's scope-exit cleanup must
 * be suppressed (the tuple's own field cleanup now owns and frees the
 * buffer). Registers every bare `move <local>` argument into the build's
 * moved set — the same suppression the move-assignment path uses. Called
 * from every constructor-call build site (declarations, assignments, and
 * the generic call builder), since monomorphized tuple inits route through
 * each of them.
 */
export default function mark_tuple_literal_move_owners(
	node: FunctionCallNode,
	status: { moved?: Set<string> },
): void {
	if (process.env.NOMEN_DBG)
		console.error(`DBG mtlmo: ${node.type?.name ?? node.name} params=${node.params.length}`);
	if (!node.type?.name?.startsWith("_Tuple_")) return;
	if (!status.moved) status.moved = new Set();
	for (const p of node.params) {
		if (p.node_type === "value" && p.is_moved && typeof (p as ValueNode).value === "string") {
			status.moved.add((p as ValueNode).value);
		}
	}
}
