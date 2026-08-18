import type BuildStatus from "../build_c/BuildStatus.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import { enter_scope_frame, exit_scope_frame } from "./utils/auto_destroy.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_if_else_node(node: IfElseNode, status: BuildStatus) {
	const label = label_counter++;
	const old_scoped_declarations = enter_scope_frame(status);

	build_node(node.condition, status);
	status.code += `\ncmp x0, #0\n`;

	// Snapshot the Buffer data-pointer cache before the conditional so each
	// branch starts from the dominating (pre-branch) state. A cache entry
	// loaded inside one branch is dropped on restore, which is sound: it is
	// not valid in a sibling branch that may not have executed the load.
	const pre_cache = status.buffer_data_cache;

	if (node.else_branch) {
		status.code += `beq else_${label}\n`;
		status.buffer_data_cache = new Map(pre_cache);
		build_block_node(node.if_branch!, status);
		status.code += `b end_${label}\n`;
		status.code += `else_${label}:\n`;
		status.buffer_data_cache = new Map(pre_cache);
		build_block_node(node.else_branch, status);
	} else {
		status.code += `beq end_${label}\n`;
		if (node.if_branch) {
			status.buffer_data_cache = new Map(pre_cache);
			build_block_node(node.if_branch, status);
		}
	}

	status.buffer_data_cache = pre_cache;

	status.code += `end_${label}:\n`;

	exit_scope_frame(status, old_scoped_declarations);
}
