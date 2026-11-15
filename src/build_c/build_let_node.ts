import { call_result_type, is_nullable_scalar_type } from "../build_common/nullable_scalar.ts";
import { is_nullable_struct_type } from "../build_common/nullable_struct.ts";
import { is_owned_string_branch_value } from "../build_common/string_return_analysis.ts";
import LetNode from "../nodes/LetNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { nullable_value_flag_expr } from "./build_assignment_node.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_let_node(node: LetNode, status: BuildStatus) {
	// A branch value that is itself a branching expression (a nested
	// `if cond -> a else -> b` inside a match or if arm) assigns the join
	// target through its OWN branch lets — emitting the `target = ` prefix
	// here would wrap a statement in an expression (`w = if (…) {…}` is
	// invalid C). Push the join target down instead; the nested if/match/
	// switch builds see the same return_assign.
	const joins_through_branches =
		node.value.node_type === "if" ||
		node.value.node_type === "match" ||
		node.value.node_type === "switch";
	// Per-arm nullable-flag join (a nullable-typed arm set on a nullable
	// slot): each arm writes the value into return_assign AND its own
	// null-ness into the slot's `_has` flag. A `null` arm writes the flag
	// only — the slot's value bytes stay stale (every read is flag-guarded,
	// the same contract a plain `p = null` store keeps). A nested branching
	// arm joins through its own lets, which see the same flag target.
	const flag_target = joins_through_branches ? undefined : status.return_assign_flag;
	if (flag_target) {
		const value = node.value;
		if (value.node_type === "value" && (value as ValueNode).value === "null") {
			status.code += `${flag_target} = 0`;
			return;
		}
		const flag_expr = nullable_value_flag_expr(value, status);
		if (flag_expr) {
			status.code += `${status.return_assign} = `;
			build_node(value, status);
			status.code += `;\n${flag_target} = ${flag_expr}`;
			return;
		}
		// A nullable-returning CALL arm forwards its own `_ret_has` through
		// the hidden out-parameter protocol — aim it at the slot's flag;
		// anything else (a fresh non-nullable value) lands non-null.
		const ret = call_result_type(value);
		const call_is_nullable =
			!!ret && (is_nullable_struct_type(ret, status) || is_nullable_scalar_type(ret, status));
		const old_flag = status.current_nullable_call_flag;
		if (call_is_nullable) status.current_nullable_call_flag = flag_target;
		status.code += `${status.return_assign} = `;
		build_node(value, status);
		status.current_nullable_call_flag = old_flag;
		if (!call_is_nullable) status.code += `;\n${flag_target} = 1`;
		return;
	}
	if (status.return_assign && !joins_through_branches) {
		status.code += `${status.return_assign} = `;
		// Mixed string-join normalization: when the enclosing match/switch/if
		// expression has both owned (interpolation/concat/call) and non-owned
		// branches, strdup the non-owned values so the join variable owns its
		// result uniformly (freed once at scope exit; a literal would crash on
		// free, a borrow would free someone else's storage).
		if (status.join_needs_owned_string && !is_owned_string_branch_value(node.value, status)) {
			status.code += `nomen_str_dup(`;
			build_node(node.value, status);
			status.code += `)`;
			return;
		}
	}
	build_node(node.value, status);
}
