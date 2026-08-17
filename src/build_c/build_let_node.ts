import { is_owned_string_branch_value } from "../build_common/string_return_analysis.ts";
import LetNode from "../nodes/LetNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_let_node(node: LetNode, status: BuildStatus) {
	if (status.return_assign) {
		status.code += `${status.return_assign} = `;
		// Mixed string-join normalization: when the enclosing match/switch/if
		// expression has both owned (interpolation/concat/call) and non-owned
		// branches, strdup the non-owned values so the join variable owns its
		// result uniformly (freed once at scope exit; a literal would crash on
		// free, a borrow would free someone else's storage). if/match/switch
		// values assign the target themselves and cannot be wrapped — their own
		// branch lets see the same flag.
		const needs_copy =
			status.join_needs_owned_string &&
			node.value.node_type !== "if" &&
			node.value.node_type !== "match" &&
			node.value.node_type !== "switch" &&
			!is_owned_string_branch_value(node.value, status);
		if (needs_copy) {
			status.code += `strdup(`;
			build_node(node.value, status);
			status.code += `)`;
			return;
		}
	}
	build_node(node.value, status);
}
