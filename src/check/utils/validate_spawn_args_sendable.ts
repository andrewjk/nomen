import add_error from "../../add_error.ts";
import type FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import type Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import is_sendable_type from "./is_sendable_type.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Validate that every argument of a spawn/detach is Sendable — everything a
 * `Thread(fn(args))` / `Fiber(fn(args))` construction packs into its task
 * environment crosses a thread boundary. Shared by the magic constructor
 * (which packs the args eagerly — docs/CLOSURE_PLAN.md Phase 3b) and the
 * nursery escape hatch.
 */
export default function validate_spawn_args_sendable(
	call: FunctionCallNode,
	status: CheckStatus,
): void {
	for (const param of call.params) {
		let arg_type: Type = type_from_value_node(param, status);
		// A constant-folded argument (e.g. `"a" + "b"` → a synthetic data
		// label value) resolves to no declared name — fall back to the
		// checker-stamped node type, which the fold sets.
		const stamped = (param as unknown as { type?: Type }).type;
		if (!arg_type.name && stamped?.name) {
			arg_type = stamped;
		}
		if (!is_sendable_type(arg_type.name, status)) {
			add_error(
				status,
				`Spawn argument of type ${arg_type.name || "<unknown>"} is not Sendable`,
				param.start,
			);
		}
	}
}
