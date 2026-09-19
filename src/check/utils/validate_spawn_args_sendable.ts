import add_error from "../../add_error.ts";
import type FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import type Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import is_sendable_type from "./is_sendable_type.ts";
import type_from_value_node from "./type_from_value_node.ts";

export interface SpawnArgValidation {
	/** At least one argument was accepted as a nursery BORROW (a
	 *  non-Sendable class/trait aliased into the task — sound only because
	 *  the enclosing nursery joins before block-scoped donors die). */
	borrow_args: boolean;
}

/**
 * Validate a spawn's packed arguments (docs/CLOSURE_PLAN.md Phase 3d).
 *
 * Every argument must be Sendable — EXCEPT, inside a nursery
 * (`allow_borrows`), a non-Sendable CLASS or TRAIT argument that is a named
 * local or parameter: it is a BORROW capture (the env aliases the instance
 * for the task's lifetime, which the nursery's join-at-exit bounds by the
 * donors' lifetimes). Temps and field accesses are not borrowable — a temp
 * dies at the statement, and a field's owner may be shallower than the
 * task.
 */
export default function validate_spawn_args_sendable(
	call: FunctionCallNode,
	status: CheckStatus,
	allow_borrows = false,
	reason?: string,
): SpawnArgValidation {
	const result: SpawnArgValidation = { borrow_args: false };
	for (const param of call.params) {
		let arg_type: Type = type_from_value_node(param, status);
		// A constant-folded argument (e.g. `"a" + "b"` → a synthetic data
		// label value) resolves to no declared name — fall back to the
		// checker-stamped node type, which the fold sets.
		const stamped = (param as unknown as { type?: Type }).type;
		if (!arg_type.name && stamped?.name) {
			arg_type = stamped;
		}
		if (is_sendable_type(arg_type.name, status)) {
			continue;
		}
		const donor =
			param.node_type === "value"
				? status.values.findLast((v) => v.name === (param as unknown as { value: string }).value)
				: undefined;
		const is_pointer_arg = (() => {
			const struct = status.structs.find((s) => s.name === arg_type.name);
			return !!struct && (struct.is_class || struct.traits.length > 0);
		})();
		if (allow_borrows && is_pointer_arg && donor) {
			result.borrow_args = true;
			continue;
		}
		if (allow_borrows && is_pointer_arg && !donor) {
			add_error(
				status,
				`Spawn argument '${arg_type.name}' is not Sendable and may only be borrowed from a named local or parameter (a temporary would die before the task runs)`,
				param.start,
			);
			continue;
		}
		add_error(
			status,
			`Spawn argument of type ${arg_type.name || "<unknown>"} is not Sendable${
				is_pointer_arg && !allow_borrows
					? (reason ??
						" — a non-Sendable class may only be passed inside a nursery (async { }), where the join bounds the borrow")
					: ""
			}`,
			param.start,
		);
	}
	return result;
}
