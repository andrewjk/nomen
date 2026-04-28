import type BuildStatus from "../build/BuildStatus.ts";
import type_from_value_node from "../build/utils/type_from_value_node.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import { allocate_stack_space, emit_var_store } from "./utils/stack_var.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_for_loop_node(node: ForLoopNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];

	const label = label_counter++;
	const item_name = node.item.value;
	const start_label = `.for_${label}`;
	const end_label = `.end_${label}`;

	status.loop_labels = status.loop_labels || [];
	status.loop_labels.push({ start: start_label, end: end_label });

	// Allocate stack space for loop item variable
	if (status.function_return_label) {
		const item_offset = allocate_stack_space(status, 8);
		status.stack_offsets!.set(item_name, item_offset);
	}

	if (node.list && node.list.node_type === "range") {
		const range = node.list as RangeNode;

		// init: item = left_value
		if (range.left_value) {
			build_node(range.left_value, status);
		} else {
			status.code += `ldr x0, =0`;
		}
		status.code += `\n`;
		emit_var_store(status, "x0", item_name, 8);

		// loop start
		status.code += `${start_label}:\n`;

		// condition: item < right_value
		build_node(node.item, status);
		status.code += `\nmov x2, x0\n`;
		if (range.right_value) {
			build_node(range.right_value, status);
		} else {
			status.code += `ldr x0, =0`;
		}
		status.code += `\ncmp x2, x0\n`;
		if (range.inclusive) {
			status.code += `bgt ${end_label}\n`;
		} else {
			status.code += `bge ${end_label}\n`;
		}

		// body
		build_block_node(node, status);

		// increment
		build_node(node.item, status);
		status.code += `\nadd x0, x0, #1\n`;
		emit_var_store(status, "x0", item_name, 8);

		status.code += `b ${start_label}\n`;
		status.code += `${end_label}:\n`;
	} else {
		// array iteration
		const type = type_from_value_node(node.list);
		const length = type.length ? (type.length as any).value : "0";

		// init: item = 0
		status.code += `ldr x0, =0\n`;
		emit_var_store(status, "x0", item_name, 8);

		// loop start
		status.code += `${start_label}:\n`;

		// condition: item < length
		build_node(node.item, status);
		status.code += `\nmov x2, x0\n`;
		status.code += `ldr x0, =${length}\n`;
		status.code += `cmp x2, x0\n`;
		status.code += `bge ${end_label}\n`;

		// body
		build_block_node(node, status);

		// increment
		build_node(node.item, status);
		status.code += `\nadd x0, x0, #1\n`;
		emit_var_store(status, "x0", item_name, 8);

		status.code += `b ${start_label}\n`;
		status.code += `${end_label}:\n`;
	}

	status.loop_labels.pop();
	status.scoped_declarations = old_scoped_declarations;
}
