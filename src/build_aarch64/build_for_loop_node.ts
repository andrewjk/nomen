import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import type { NirStmt } from "../nir/nir.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import build_node from "./build_node.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { enter_scope_frame, exit_scope_frame } from "./utils/auto_destroy.ts";
import { promote_loop_locals, type PromotedVar } from "./utils/loop_promotion.ts";
import {
	allocate_stack_space,
	emit_promoted_store,
	emit_var_address,
	emit_var_load,
	emit_var_store,
} from "./utils/stack_var.ts";
import { get_struct_size } from "./utils/struct_layout.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_for_loop_node(
	node: ForLoopNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "for" },
) {
	const old_scoped_declarations = enter_scope_frame(status);

	const label = label_counter++;
	const item_name = node.item.value;
	const start_label = `.for_${label}`;
	const end_label = `.end_${label}`;
	const increment_label = `.for_inc_${label}`;
	const continue_label = node.update ? `.for_update_${label}` : increment_label;

	status.loop_labels = status.loop_labels || [];
	const cleanup_depth = status.heap_cleanup_stack?.length ?? 0;
	status.loop_labels.push({
		start: continue_label,
		end: end_label,
		cleanup_depth,
	});
	if (!status.loop_writebacks) status.loop_writebacks = [];
	status.loop_writebacks.push(undefined);

	if (status.function_return_label) {
		const item_offset = allocate_stack_space(status, 8);
		status.stack_offsets!.set(item_name, item_offset);
	}

	const promoted: PromotedVar[] = [];
	const saved_reg_allocs = status.register_allocations
		? new Map(status.register_allocations)
		: undefined;
	const saved_buffer_cache = status.buffer_data_cache;
	status.buffer_data_cache = undefined;

	if (status.function_return_label && node.statements.length > 0) {
		promoted.push(
			...promote_loop_locals(status, old_scoped_declarations, {
				statements: node.statements,
				update: node.update,
			}),
		);
	}

	if (node.list && node.list.node_type === "range") {
		const range = node.list as RangeNode;

		if (range.left_value) {
			build_node(range.left_value, status);
		} else {
			status.code += `ldr x0, =0`;
		}
		status.code += `\n`;
		emit_var_store(status, "x0", item_name, 8);

		status.code += `${start_label}:\n`;

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

		build_block_with_cursor(node, nir?.body, status);

		if (node.update) {
			status.code += `${continue_label}:\n`;
			build_node(node.update, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}

		status.code += `${increment_label}:\n`;
		build_node(node.item, status);
		status.code += `\nadd x0, x0, #1\n`;
		emit_var_store(status, "x0", item_name, 8);

		status.code += `b ${start_label}\n`;
		status.code += `${end_label}:\n`;
	} else if (node.list && is_enumerable_type(node.list, status)) {
		// Enumerable type: call .length() and iterate 0..length
		const list_name = node.list.node_type === "value" ? (node.list as any).value : "_list";

		// Call container.length() to get upper bound
		status.code += `// call ${list_name}.length()\n`;
		emit_var_address(status, "x0", list_name);
		status.code += `str x0, [sp, #-16]!\n`;
		status.code += `bl ${list_name}_length\n`;
		status.code += `add sp, sp, #16\n`;
		// x0 now has length; store it in a temp
		const len_offset = allocate_stack_space(status, 8);
		status.code += `str x0, [x29, #${len_offset}]\n`;

		// Initialize index to 0
		status.code += `ldr x0, =0\n`;
		emit_var_store(status, "x0", item_name, 8);

		status.code += `${start_label}:\n`;

		// Load index
		emit_var_load(status, "x0", item_name, 8);
		// Load length
		status.code += `ldr x1, [x29, #${len_offset}]\n`;
		status.code += `cmp x0, x1\n`;
		status.code += `bge ${end_label}\n`;

		build_block_with_cursor(node, nir?.body, status);

		if (node.update) {
			status.code += `${continue_label}:\n`;
			build_node(node.update, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}

		status.code += `${increment_label}:\n`;
		emit_var_load(status, "x0", item_name, 8);
		status.code += `add x0, x0, #1\n`;
		emit_var_store(status, "x0", item_name, 8);

		status.code += `b ${start_label}\n`;
		status.code += `${end_label}:\n`;
	} else {
		const type = type_from_value_node(node.list);
		const length = type.length ? (type.length as any).value : "0";
		const struct_type = status.structs.find((s) => s.name === type.name && !s.is_simple_type);
		const element_size = struct_type
			? struct_type.is_class
				? 8
				: get_struct_size(type.name, status)
			: type.name
				? aarch64_size(type.name)
				: 8;
		const idx_name = `_idx_${item_name}`;

		if (struct_type && status.function_return_label) {
			const struct_size = element_size;
			const item_offset = allocate_stack_space(status, struct_size);
			status.stack_offsets!.set(item_name, item_offset);
		}

		if (status.function_return_label) {
			const idx_offset = allocate_stack_space(status, 8);
			status.stack_offsets!.set(idx_name, idx_offset);
		}

		const list_name = node.list.node_type === "value" ? (node.list as any).value : "_list";
		const list_type = type_from_value_node(node.list);
		const list_is_pointer =
			list_type.is_array &&
			(!!status.function_array_params?.has(list_name) || !!status.heap_array_vars?.has(list_name));

		// Dynamic-length arrays (heap-allocated via Array.with, or array params
		// whose length isn't known at compile time) need the runtime length from
		// the buffer prefix. When the type carries a compile-time length (e.g. a
		// fixed-size literal passed to a function), use that instead.
		let dyn_len_offset: number | undefined;
		if (status.function_return_label && list_is_pointer && !type.length) {
			dyn_len_offset = allocate_stack_space(status, 8);
			emit_var_load(status, "x0", list_name, 8);
			if (status.heap_array_vars?.has(list_name)) {
				status.code += `ldr x0, [x0]\n`;
			} else {
				status.code += `ldr x0, [x0, #-8]\n`;
			}
			status.code += `str x0, [x29, #${dyn_len_offset}]\n`;
		}

		status.code += `ldr x0, =0\n`;
		emit_var_store(status, "x0", idx_name, 8);

		status.code += `${start_label}:\n`;

		emit_var_load(status, "x0", idx_name, 8);
		status.code += `mov x2, x0\n`;
		if (dyn_len_offset !== undefined) {
			status.code += `ldr x0, [x29, #${dyn_len_offset}]\n`;
		} else {
			status.code += `ldr x0, =${length}\n`;
		}
		status.code += `cmp x2, x0\n`;
		status.code += `bge ${end_label}\n`;

		if (list_is_pointer) {
			emit_var_load(status, "x3", list_name, 8);
			if (status.heap_array_vars?.has(list_name)) {
				status.code += `add x3, x3, #8\n`;
			}
		} else {
			emit_var_address(status, "x3", list_name);
		}
		emit_var_load(status, "x1", idx_name, 8);
		const shift = Math.log2(element_size);
		if (Number.isInteger(shift) && shift > 0) {
			status.code += `add x0, x3, x1, lsl #${shift}\n`;
		} else {
			status.code += `mov x2, #${element_size}\n`;
			status.code += `mul x1, x1, x2\n`;
			status.code += `add x0, x3, x1\n`;
		}
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

		// For `for ref x of arr`, create a write-back that recomputes the
		// element address and stores the (possibly mutated) item back. Called
		// after the body and before break/continue.
		if (node.item_is_ref) {
			const wb_struct_type = struct_type;
			const wb_element_size = element_size;
			const wb_item_name = item_name;
			const wb_idx_name = idx_name;
			const wb_list_name = list_name;
			const wb_list_is_pointer = list_is_pointer;
			const wb_shift = shift;
			status.loop_writebacks![status.loop_writebacks.length - 1] = () => {
				// Recompute element address into x9.
				if (wb_list_is_pointer) {
					emit_var_load(status, "x9", wb_list_name, 8);
					if (status.heap_array_vars?.has(wb_list_name)) {
						status.code += `add x9, x9, #8\n`;
					}
				} else {
					emit_var_address(status, "x9", wb_list_name);
				}
				emit_var_load(status, "x10", wb_idx_name, 8);
				if (Number.isInteger(wb_shift) && wb_shift > 0) {
					status.code += `add x9, x9, x10, lsl #${wb_shift}\n`;
				} else {
					status.code += `mov x11, #${wb_element_size}\n`;
					status.code += `mul x10, x10, x11\n`;
					status.code += `add x9, x9, x10\n`;
				}
				if (wb_struct_type) {
					const item_offset = status.stack_offsets!.get(wb_item_name);
					if (item_offset !== undefined) {
						const words = Math.ceil(wb_element_size / 8);
						for (let w = 0; w < words; w++) {
							status.code += `ldr x10, [x29, #${item_offset + w * 8}]\n`;
							status.code += `str x10, [x9, #${w * 8}]\n`;
						}
					}
				} else {
					if (wb_element_size === 1) {
						emit_var_load(status, "x10", wb_item_name, wb_element_size);
						status.code += `strb w10, [x9]\n`;
					} else if (wb_element_size === 4) {
						emit_var_load(status, "x10", wb_item_name, wb_element_size);
						status.code += `str w10, [x9]\n`;
					} else {
						emit_var_load(status, "x10", wb_item_name, wb_element_size);
						status.code += `str x10, [x9]\n`;
					}
				}
			};
		}

		build_block_with_cursor(node, nir?.body, status);

		// Write the (possibly mutated) loop variable back into its array slot.
		status.loop_writebacks![status.loop_writebacks.length - 1]?.();

		if (node.update) {
			status.code += `${continue_label}:\n`;
			build_node(node.update, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}

		status.code += `${increment_label}:\n`;
		emit_var_load(status, "x0", idx_name, 8);
		status.code += `add x0, x0, #1\n`;
		emit_var_store(status, "x0", idx_name, 8);

		status.code += `b ${start_label}\n`;
		status.code += `${end_label}:\n`;
	}

	for (const p of promoted) {
		// Store back with the slot's width — a full-width `str` into a
		// sub-word slot would clobber the adjacent stack bytes.
		emit_promoted_store(status, p.reg, p.offset, p.type_name);
	}

	if (saved_reg_allocs) {
		status.register_allocations = saved_reg_allocs;
	} else {
		status.register_allocations = undefined;
	}

	status.buffer_data_cache = saved_buffer_cache;
	status.loop_labels.pop();
	status.loop_writebacks?.pop();
	exit_scope_frame(status, old_scoped_declarations);
}

function is_enumerable_type(node: any, status: BuildStatus): boolean {
	if (node.node_type !== "value") return false;
	const type_name = node.value;
	const struct = status.structs.find((s) => s.name === type_name);
	if (!struct) return false;
	return struct.traits.includes("Enumerable");
}
