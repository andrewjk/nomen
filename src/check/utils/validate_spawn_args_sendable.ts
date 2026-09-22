import add_error from "../../add_error.ts";
import type FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import type Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import is_sendable_type from "./is_sendable_type.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Validate a spawn's packed arguments (CLOSURE.md Phase 3d; ASYNC_PLAN
 * phase 5 — the shrunk `Sendable`).
 *
 * `Sendable` gates exactly the case that can race: a SHARED class/trait
 * reference crossing the task boundary (a plain argument — the packed env
 * aliases the instance). Everything else is exempt:
 *
 * - MOVED arguments: the callee's `move T` parameter takes exclusive
 *   ownership, so no one else can touch the instance concurrently;
 * - scalars, strings, and everything `is_sendable_type` accepts (copied or
 *   safe by value — strings are deep-copied at pack);
 * - owning VALUE structs whose fields are all safe (the pack deep-copies
 *   them; `is_sendable_type`'s field recursion rejects a struct with an
 *   unsafe class field).
 *
 * The nursery-borrow exception (a non-Sendable class aliased into a task
 * inside `async { }`) is RETIRED: mark the class `Sendable`, move it in
 * (a `move` parameter), or share it through a `Sendable` primitive
 * (`Mutex`/`Channel`).
 */
export default function validate_spawn_args_sendable(
	call: FunctionCallNode,
	status: CheckStatus,
	reason?: string,
): void {
	const callee_params = (call.resolved_function as FunctionNode | undefined)?.params?.filter(
		(p) => !p.is_self_param,
	);
	for (let i = 0; i < call.params.length; i++) {
		const param = call.params[i];
		let arg_type: Type = type_from_value_node(param, status);
		// A constant-folded argument (e.g. `"a" + "b"` → a synthetic data
		// label value) resolves to no declared name — fall back to the
		// checker-stamped node type, which the fold sets.
		const stamped = (param as unknown as { type?: Type }).type;
		if (!arg_type.name && stamped?.name) {
			arg_type = stamped;
		}
		// MOVED: the callee's `move T` parameter takes exclusive ownership
		// of the argument — no sharing, no race.
		if (callee_params?.[i]?.is_moved) {
			continue;
		}
		if (is_sendable_type(arg_type.name, status)) {
			continue;
		}
		add_error(
			status,
			`Spawn argument of type ${arg_type.name || "<unknown>"} is not Sendable${
				reason ??
				" — a shared class/trait reference crossing a task boundary must be marked Sendable; move it in (a `move` parameter) or share it through a Sendable primitive (Mutex/Channel)"
			}`,
			param.start,
		);
	}
}
