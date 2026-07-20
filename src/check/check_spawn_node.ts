import add_error from "../add_error.ts";
import SpawnNode from "../nodes/SpawnNode.ts";
import check_function_call_node from "./check_function_call_node.ts";
import type CheckStatus from "./CheckStatus.ts";

/**
 * Check a `spawn <call>` node. Delegates to check_function_call_node for the
 * wrapped call (which resolves the function, fills in param types, etc.).
 *
 * For v1, the spawned function's return type is ignored — spawn is
 * fire-and-forget. Result-returning Task<T> comes later.
 */
export default function check_spawn_node(node: SpawnNode, status: CheckStatus): boolean {
	const ok = check_function_call_node(node.call, status);
	if (!ok) {
		add_error(status, "Spawned call did not resolve", node.start);
	}
	return ok;
}
