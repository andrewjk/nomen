import type BuildStatus from "../build_c/BuildStatus.ts";
import type { NirStmt } from "../nir/nir.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import build_node from "./build_node.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import { enter_scope_frame, exit_scope_frame } from "./utils/auto_destroy.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_switch_node(
	node: SwitchNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "switch_match" },
) {
	const label = label_counter++;
	const old_scoped_declarations = enter_scope_frame(status);
	const pre_cache = status.buffer_data_cache;
	const pre_array_cache = status.array_ptr_cache;

	for (let i = 0; i < node.cases.length; i++) {
		status.scoped_declarations = [];

		build_node(node.cases[i].condition, status);
		status.code += `\ncmp x0, #0\n`;

		if (i < node.cases.length - 1 || node.else_branch) {
			status.code += `beq sw_next_${label}_${i}\n`;
		} else {
			status.code += `beq end_switch_${label}\n`;
		}

		status.buffer_data_cache = new Map(pre_cache);
		status.array_ptr_cache = new Map(pre_array_cache);
		build_block_with_cursor(node.cases[i].branch, nir?.arms[i]?.branch, status);
		status.code += `b end_switch_${label}\n`;

		status.code += `sw_next_${label}_${i}:\n`;
	}

	if (node.else_branch) {
		status.scoped_declarations = [];
		status.buffer_data_cache = new Map(pre_cache);
		status.array_ptr_cache = new Map(pre_array_cache);
		build_block_with_cursor(node.else_branch, nir?.otherwise ?? undefined, status);
	}

	status.buffer_data_cache = pre_cache;
	status.array_ptr_cache = pre_array_cache;

	status.code += `end_switch_${label}:\n`;

	exit_scope_frame(status, old_scoped_declarations);
}
