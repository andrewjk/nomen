import { is_owned_string_branch_value } from "../build_common/string_return_analysis.ts";
import LetNode from "../nodes/LetNode.ts";
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
