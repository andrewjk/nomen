import add_error from "../add_error.ts";
import SpawnNode from "../nodes/SpawnNode.ts";
import Type from "../nodes/Type.ts";
import check_function_call_node from "./check_function_call_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import is_sendable_type from "./utils/is_sendable_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

/**
 * Check a `spawn <call>` node. Delegates to check_function_call_node for the
 * wrapped call (which resolves the function, fills in param types, etc.).
 *
 * Enforces that every argument is `Sendable` — see ASYNC.md.
 *
 * The expression's type is `Task` (the runtime handle for the spawned work).
 */
export default function check_spawn_node(node: SpawnNode, status: CheckStatus): boolean {
	const ok = check_function_call_node(node.call, status);
	if (!ok) {
		add_error(status, "Spawned call did not resolve", node.start);
		return false;
	}

	// Validate each argument is Sendable.
	for (const param of node.call.params) {
		const arg_type = type_from_value_node(param, status);
		if (!is_sendable_type(arg_type.name, status)) {
			add_error(
				status,
				`Spawn argument of type ${arg_type.name || "<unknown>"} is not Sendable`,
				param.start,
			);
		}
	}

	// The expression yields a Task handle. Capture the wrapped function's
	// return type first — build_spawn_node reads it off SpawnNode to decide
	// whether to emit a result-capturing trampoline.
	node.function_return_type = node.call.type;
	node.call.type = new Type("Task");
	return true;
}

