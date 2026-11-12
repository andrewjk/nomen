import add_error from "../add_error.ts";
import { null_chain_base } from "../build_common/null_chain.ts";
import NullAccessNode from "../nodes/NullAccessNode.ts";
import Type from "../nodes/Type.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";

/**
 * ERRORS_PLAN: nullable chaining — `a?.b` (chains: `a?.b?.c`).
 *
 * The result is the member's type made nullable: null when the target is
 * null, the member otherwise. In v1 the chain's nullness must be CONSUMED
 * (the language's nullable representations are per-slot): the supported
 * consumers are `chain ?? fallback` and `chain == null` / `!= null`; a
 * chain in any other position is rejected with a message naming those
 * forms.
 */
export default function check_null_access_node(node: NullAccessNode, status: CheckStatus): boolean {
	// The chain must bottom out at a name / field path: a call inside the
	// chain would be evaluated once per hop test and again for the value.
	if (!null_chain_base(node)) {
		add_error(
			status,
			`'?.' chains must start at a name or field path — hoist the expression into a local first`,
			node.start,
		);
		return false;
	}
	// The chain TOLERATES a null target (that is the operator's point) — the
	// plain read-rejection ("may be null" / known-null) is suspended for the
	// target check.
	const old_allow_null = status.allow_null_value;
	status.allow_null_value = true;
	const target_ok = check_node(node.target, status);
	status.allow_null_value = old_allow_null;
	if (!target_ok) return false;
	const target_type = type_from_value_node(node.target, status);
	if (!target_type.is_nullable) {
		add_error(
			status,
			`'?.' needs a nullable target — '${type_name(target_type)}' is not nullable; use '.'`,
			node.start,
		);
		return false;
	}

	// Resolve the member on the base (non-null) type.
	const base_name = target_type.name;
	const struct = status.structs.findLast((s) => s.name === base_name && !s.is_generic);
	const field = struct?.fields.find((f) => f.name === node.access.name);
	if (!field?.type?.name) {
		add_error(status, `Field not found: ${node.access.name}`, node.access.start);
		return false;
	}
	node.access.type = clone_type(field.type);
	node.type = clone_type(field.type);
	node.type.is_nullable = true;

	return true;
}

function clone_type(t: Type): Type {
	const c = new Type(t.name, t.is_static, t.is_array, t.length);
	c.is_ref = t.is_ref;
	c.is_nullable = t.is_nullable;
	c.type_args = t.type_args;
	return c;
}
