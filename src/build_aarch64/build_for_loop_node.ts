import type BuildStatus from "../build/BuildStatus.ts";
import type_from_value_node from "../build/utils/type_from_value_node.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import {
	allocate_stack_space,
	emit_var_address,
	emit_var_load,
	emit_var_store,
} from "./utils/stack_var.ts";
import { get_struct_size } from "./utils/struct_layout.ts";

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
	const increment_label = `.for_inc_${label}`;
	const continue_label = node.update ? `.for_update_${label}` : increment_label;

	status.loop_labels = status.loop_labels || [];
	const cleanup_depth = status.heap_cleanup_stack?.length ?? 0;
	status.loop_labels.push({ start: continue_label, end: end_label, cleanup_depth });

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
		const right_is_literal = range.right_value?.node_type === "value";
		if (right_is_literal) {
			status.code += `\nmov x2, x0\n`;
			if (range.right_value) {
				build_node(range.right_value, status);
			} else {
				status.code += `ldr x0, =0`;
			}
			status.code += `\ncmp x2, x0\n`;
		} else {
			status.code += `\nstr x0, [sp, #-16]!\n`;
			if (range.right_value) {
				build_node(range.right_value, status);
			} else {
				status.code += `ldr x0, =0`;
			}
			status.code += `\nmov x2, x0\n`;
			status.code += `ldr x1, [sp], #16\n`;
			status.code += `cmp x1, x2\n`;
		}
		status.code += `bge ${end_label}\n`;

		// body
		build_block_node(node, status);

		// update clause
		if (node.update) {
			status.code += `${continue_label}:\n`;
			build_node(node.update, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}

		// increment
		status.code += `${increment_label}:\n`;
		build_node(node.item, status);
		status.code += `\nadd x0, x0, #1\n`;
		emit_var_store(status, "x0", item_name, 8);

		status.code += `b ${start_label}\n`;
		status.code += `${end_label}:\n`;
	} else {
		// array iteration using hidden index variable
		const type = type_from_value_node(node.list);
		const length = type.length ? (type.length as any).value : "0";
		const struct_type = status.structs.find((s) => s.name === type.name && !s.is_simple_type);
		const element_size = struct_type
			? get_struct_size(type.name, status)
			: type.name
				? aarch64_size(type.name)
				: 8;
		const idx_name = `_idx_${item_name}`;

		if (struct_type && status.function_return_label) {
			const struct_size = element_size;
			const item_offset = allocate_stack_space(status, struct_size);
			status.stack_offsets!.set(item_name, item_offset);
		}

		// Allocate stack space for index variable
		if (status.function_return_label) {
			const idx_offset = allocate_stack_space(status, 8);
			status.stack_offsets!.set(idx_name, idx_offset);
		}

		// init: index = 0
		status.code += `ldr x0, =0\n`;
		emit_var_store(status, "x0", idx_name, 8);

		// loop start
		status.code += `${start_label}:\n`;

		// condition: index < length
		emit_var_load(status, "x0", idx_name, 8);
		status.code += `mov x2, x0\n`;
		status.code += `ldr x0, =${length}\n`;
		status.code += `cmp x2, x0\n`;
		status.code += `bge ${end_label}\n`;

		// Load array[index] into item variable
		const list_name = node.list.node_type === "value" ? (node.list as any).value : "_list";
		const list_type = type_from_value_node(node.list);
		const list_is_pointer = list_type.is_array && !!status.function_array_params?.has(list_name);
		if (list_is_pointer) {
			emit_var_load(status, "x3", list_name, 8);
		} else {
			emit_var_address(status, "x3", list_name);
		}
		emit_var_load(status, "x1", idx_name, 8);
		status.code += `mov x2, #${element_size}\n`;
		status.code += `mul x1, x1, x2\n`;
		status.code += `add x0, x3, x1\n`;
		if (struct_type) {
			const item_offset = status.stack_offsets!.get(item_name);
			if (item_offset !== undefined) {
				const words = Math.ceil(element_size / 8);
				for (let w = 0; w < words; w++) {
					status.code += `ldr x1, [x0, #${w * 8}]\n`;
					status.code += `str x1, [x29, #${item_offset + w * 8}]\n`;
				}
			}
		} else {
			if (element_size === 1) {
				status.code += `ldrb w0, [x0]\n`;
			} else if (element_size === 4) {
				status.code += `ldr w0, [x0]\n`;
			} else {
				status.code += `ldr x0, [x0]\n`;
			}
			emit_var_store(status, "x0", item_name, element_size);
		}

		// body
		build_block_node(node, status);

		// update clause
		if (node.update) {
			status.code += `${continue_label}:\n`;
			build_node(node.update, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}

		// increment: index++
		status.code += `${increment_label}:\n`;
		emit_var_load(status, "x0", idx_name, 8);
		status.code += `add x0, x0, #1\n`;
		emit_var_store(status, "x0", idx_name, 8);

		status.code += `b ${start_label}\n`;
		status.code += `${end_label}:\n`;
	}

	status.loop_labels.pop();
	status.scoped_declarations = old_scoped_declarations;
}
