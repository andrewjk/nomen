import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
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
	const match_type = type_from_value_node(node.value);
	const match_type_name = match_type?.name;
	const enum_with_data = match_type_name
		? status.enums.find((e) => e.name === match_type_name && e.has_associated_data)
		: null;

	if (enum_with_data) {
		status.code += `stp x19, x20, [sp, #-16]!\n`;
		status.match_save_size = (status.match_save_size || 0) + 16;
	} else {
		status.code += `str x19, [sp, #-16]!\n`;
		status.match_save_size = (status.match_save_size || 0) + 16;
	}

	build_node(node.value, status);
	ensure_newline(status);

	if (enum_with_data) {
		status.code += `mov x20, x0\n`;
		status.code += `ldr x19, [x20]\n`;
	} else {
		status.code += `mov x19, x0\n`;
	}

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

		if (enum_with_data) {
			const old_param_regs = status.function_param_regs;
			const param_name = node.value.node_type === "value" ? (node.value as any).value : null;
			if (param_name && old_param_regs?.get(param_name) === "x19") {
				status.function_param_regs = new Map(old_param_regs);
				status.function_param_regs.set(param_name, "x20");
			}
			build_block_node(node.cases[i].branch, status);
			status.function_param_regs = old_param_regs;
		} else {
			build_block_node(node.cases[i].branch, status);
		}
		status.code += `b end_match_${label}\n`;

		status.code += `case_next_${label}_${i}:\n`;
	}

	if (node.else_branch) {
		status.scoped_declarations = [];
		build_block_node(node.else_branch, status);
	}

	status.code += `end_match_${label}:\n`;
	if (enum_with_data) {
		status.code += `ldp x19, x20, [sp], #16\n`;
		status.match_save_size = (status.match_save_size || 0) - 16;
	} else {
		status.code += `ldr x19, [sp], #16\n`;
		status.match_save_size = (status.match_save_size || 0) - 16;
	}

	status.scoped_declarations = old_scoped_declarations;
}
