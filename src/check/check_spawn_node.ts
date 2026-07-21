import add_error from "../add_error.ts";
import SpawnNode from "../nodes/SpawnNode.ts";
import Type from "../nodes/Type.ts";
import check_function_call_node, { monomorphize } from "./check_function_call_node.ts";
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

	// The expression yields a Task<T> handle where T is the spawned function's
	// return type. For void-returning functions, T defaults to uint64 (the
	// result slot exists but is never read via result()).
	const return_type = node.call.type;
	const result_type_arg =
		return_type && return_type.name && return_type.name !== "void" && return_type.name !== "?"
			? new Type(return_type.name)
			: new Type("uint64");
	const task_type = new Type("Task");
	task_type.type_args = [result_type_arg];
	node.function_return_type = return_type;
	node.call.type = task_type;

	// Trigger monomorphization of Task<T> so the struct body (Task_uint64 etc.)
	// is added to root.statements and emitted by the build phase.
	const task_struct = status.structs.find((s) => s.name === "Task");
	if (task_struct && task_struct.type_params.length > 0) {
		monomorphize(task_struct, [result_type_arg], status);
	}

	return true;
}
