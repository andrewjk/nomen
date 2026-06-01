import type BuildStatus from "../../build/BuildStatus.ts";
import type_from_value_node from "../../build/utils/type_from_value_node.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import build_node from "../build_node.ts";
import { find_anchor_slot } from "./auto_destroy.ts";
import { emit_var_address } from "./stack_var.ts";
import { get_field_offset } from "./struct_layout.ts";

export function build_swap_params(node: FunctionCallNode, status: BuildStatus) {
	if (!node.swap_params?.size) return;

	for (const [idx, swap_expr] of node.swap_params) {
		const source = node.params[idx];
		if (!source) continue;

		build_node(swap_expr, status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `str x0, [sp, #-16]!\n`;

		if (
			source.node_type === "access" &&
			(source as AccessNode).access.node_type === "access_field"
		) {
			const src_access = source as AccessNode;
			const src_field = (src_access.access as AccessFieldNode).name;
			const src_target_type = type_from_value_node(src_access.target);
			const src_offset = get_field_offset(src_target_type.name, src_field, status);

			const target_name = (src_access.target as ValueNode).value;
			emit_var_address(status, "x0", target_name);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `ldr x1, [sp], #16\n`;
			status.code += `str x1, [x0, #${src_offset}]\n`;
		} else if (source.node_type === "value") {
			const src_name = (source as ValueNode).value;
			emit_var_address(status, "x0", src_name);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `ldr x1, [sp], #16\n`;
			status.code += `str x1, [x0]\n`;
			const anchor = find_anchor_slot(status, src_name);
			if (anchor !== undefined) {
				status.code += `str x1, [x29, #${anchor}]\n`;
			}
			status.moved?.delete(src_name);
		}
	}
}
