import type BuildStatus from "../build_c/BuildStatus.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_switch_node(node: SwitchNode, status: BuildStatus) {
	const label = label_counter++;
	const old_scoped_declarations = status.scoped_declarations;

	for (let i = 0; i < node.cases.length; i++) {
		status.scoped_declarations = [];

		build_node(node.cases[i].condition, status);
		status.code += `\ncmp x0, #0\n`;

		if (i < node.cases.length - 1 || node.else_branch) {
			status.code += `beq case_next_${label}_${i}\n`;
		} else {
			status.code += `beq end_switch_${label}\n`;
		}

		build_block_node(node.cases[i].branch, status);
		status.code += `b end_switch_${label}\n`;

		status.code += `case_next_${label}_${i}:\n`;
	}

	if (node.else_branch) {
		status.scoped_declarations = [];
		build_block_node(node.else_branch, status);
	}

	status.code += `end_switch_${label}:\n`;

	status.scoped_declarations = old_scoped_declarations;
}
