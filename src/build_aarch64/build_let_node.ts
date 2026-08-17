import type BuildStatus from "../build_c/BuildStatus.ts";
import { is_owned_string_branch_value } from "../build_common/string_return_analysis.ts";
import LetNode from "../nodes/LetNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_strdup } from "./utils/audit.ts";
import { emit_var_store } from "./utils/stack_var.ts";

function find_var_size(name: string, status: BuildStatus): number {
	const decl = status.scoped_declarations?.find((d) => d.name === name);
	if (decl?.type?.name) {
		return aarch64_size(decl.type.name);
	}
	return 8;
}

export default function build_let_node(node: LetNode, status: BuildStatus) {
	build_node(node.value, status);
	if (status.return_assign) {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		// Mixed string-join normalization: when the enclosing match/switch/if
		// expression has both owned (interpolation/concat/call) and non-owned
		// branches, strdup the non-owned values (a literal's rodata pointer, a
		// borrow) so the join variable uniformly owns its result — the scope
		// exit free would abort on a raw rodata/borrow pointer. if/match/switch
		// values assign the target themselves; their own branch lets see the
		// same flag.
		if (
			status.join_needs_owned_string &&
			node.value.node_type !== "if" &&
			node.value.node_type !== "match" &&
			node.value.node_type !== "switch" &&
			!is_owned_string_branch_value(node.value, status)
		) {
			emit_strdup(status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}
		const size = find_var_size(status.return_assign, status);
		emit_var_store(status, "x0", status.return_assign, size);
	}
}
