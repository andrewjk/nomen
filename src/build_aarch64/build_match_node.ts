import type BuildStatus from "../build/BuildStatus.ts";
import MatchNode from "../nodes/MatchNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

function ensure_newline(status: BuildStatus) {
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
}

export default function build_match_node(node: MatchNode, status: BuildStatus) {
	const label = label_counter++;
	const old_scoped_declarations = status.scoped_declarations;

	status.code += `str x19, [sp, #-16]!\n`;

	build_node(node.value, status);
	ensure_newline(status);
	status.code += `mov x19, x0\n`;

	for (let i = 0; i < node.cases.length; i++) {
		status.scoped_declarations = [];

		build_node(node.cases[i].match_value, status);
		ensure_newline(status);
		status.code += `cmp x0, x19\n`;

		if (i < node.cases.length - 1 || node.else_branch) {
			status.code += `bne case_next_${label}_${i}\n`;
		} else {
			status.code += `bne end_match_${label}\n`;
		}

		build_block_node(node.cases[i].branch, status);
		status.code += `b end_match_${label}\n`;

		status.code += `case_next_${label}_${i}:\n`;
	}

	if (node.else_branch) {
		status.scoped_declarations = [];
		build_block_node(node.else_branch, status);
	}

	status.code += `end_match_${label}:\n`;
	status.code += `ldr x19, [sp], #16\n`;

	status.scoped_declarations = old_scoped_declarations;
}
