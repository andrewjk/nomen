import type BuildStatus from "../build_c/BuildStatus.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_malloc } from "./utils/audit.ts";
import {
	emit_destroy_for_decl,
	emit_heap_slots_cleanup_for_return,
	mark_moved_if_struct,
} from "./utils/auto_destroy.ts";
import { emit_var_address, emit_var_store } from "./utils/stack_var.ts";
import { emit_struct_copy, get_struct_size } from "./utils/struct_layout.ts";

function find_var_size(name: string, status: BuildStatus): number {
	const decl = status.scoped_declarations?.find((d) => d.name === name);
	if (decl?.type?.name) {
		return aarch64_size(decl.type.name);
	}
	return 8;
}

export default function build_return_node(node: ReturnNode, status: BuildStatus) {
	if (node.from_inline) {
		return;
	}

	if (!node.value) {
		if (status.return_assign) {
			const size = find_var_size(status.return_assign, status);
			status.code += `mov x0, #0\n`;
			emit_var_store(status, "x0", status.return_assign, size);
		} else if (status.function_return_label) {
			const finalized = status.moved ?? new Set<string>();
			for (const decl of status.scoped_declarations) {
				if (finalized.has(decl.name)) continue;
				emit_destroy_for_decl(
					status,
					decl.name,
					decl.type.name,
					undefined,
					decl.type.type_args,
					decl.type.is_nullable,
				);
			}
			emit_heap_slots_cleanup_for_return(status);
			status.code += `mov x0, #0\n`;
			const match_saves = status.match_save_size || 0;
			if (match_saves > 0) {
				for (let i = 0; i < match_saves; i += 16) {
					status.code += `ldr x19, [sp], #16\n`;
				}
			}
			status.code += `b ${status.function_return_label}\n`;
		}
		return;
	}

	build_node(node.value, status);
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}

	if (status.last_result_is_heap && status.function_return_type?.name === "string") {
		if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
		if (status.current_function_name) {
			status.heap_returning_functions.add(status.current_function_name);
		}
	}

	if (status.function_return_label && status.struct_return_buffer && status.function_return_type) {
		const ret_struct = status.structs.find(
			(s) => s.name === status.function_return_type!.name && !s.is_simple_type && !s.is_class,
		);
		if (ret_struct) {
			if (status.return_buffer_stack_offset !== undefined) {
				status.code += `ldr x8, [x29, #${status.return_buffer_stack_offset}]\n`;
			}
			const struct_size = get_struct_size(status.function_return_type!.name, status);
			if (node.value.node_type === "value") {
				const var_name = (node.value as ValueNode).value;
				const paramReg = status.function_param_regs?.get(var_name);
				if (paramReg) {
					emit_struct_copy(paramReg, "x8", 0, struct_size, status);
				} else {
					emit_var_address(status, "x0", var_name);
					emit_struct_copy("x0", "x8", 0, struct_size, status);
				}
			} else {
				emit_struct_copy("x0", "x8", 0, struct_size, status);
			}
		}
	}

	if (status.return_assign) {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		const size = find_var_size(status.return_assign, status);
		emit_var_store(status, "x0", status.return_assign, size);
	} else if (status.function_return_label) {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}

		const return_type = status.function_return_type;
		if (return_type?.is_array) {
			const struct_element = status.structs.find(
				(s) => s.name === return_type.name && !s.is_simple_type,
			);
			const element_size = struct_element
				? struct_element.is_class
					? 8
					: get_struct_size(return_type.name, status)
				: aarch64_size(return_type.name);
			const var_name = node.value?.node_type === "value" ? (node.value as any).value : undefined;
			const decl = var_name
				? status.scoped_declarations?.find((d) => d.name === var_name)
				: undefined;
			const array_len =
				decl?.value?.node_type === "array"
					? (decl.value as any).values.length
					: decl?.type?.length
						? parseInt((decl.type.length as any).value || "0")
						: 0;
			const total_size = array_len * element_size;
			if (total_size > 0) {
				status.code += `str x0, [sp, #-16]!\n`;
				status.code += `mov x0, #${8 + total_size}\n`;
				emit_malloc(status);
				status.code += `mov x1, x0\n`;
				status.code += `mov x2, #${array_len}\n`;
				status.code += `str x2, [x1]\n`;
				status.code += `add x1, x1, #8\n`;
				status.code += `ldr x2, [sp]\n`;
				const words = Math.ceil(total_size / 8);
				for (let i = 0; i < words; i++) {
					status.code += `ldr x3, [x2, #${i * 8}]\n`;
					status.code += `str x3, [x1, #${i * 8}]\n`;
				}
				status.code += `add sp, sp, #16\n`;
			}
			if (struct_element?.is_class && var_name) {
				if (!status.moved) status.moved = new Set();
				const offset = status.stack_offsets?.get(var_name) ?? 0;
				for (let i = 0; i < array_len; i++) {
					const anchor_name = `${var_name}_elem_${offset + i * element_size}`;
					status.moved.add(anchor_name);
				}
			}
		}

		mark_moved_if_struct(node.value, status);
		const finalized = status.moved ?? new Set<string>();
		status.code += `str x0, [sp, #-16]!\n`;
		for (const decl of status.scoped_declarations) {
			if (finalized.has(decl.name)) continue;
			emit_destroy_for_decl(
				status,
				decl.name,
				decl.type.name,
				undefined,
				decl.type.type_args,
				decl.type.is_nullable,
			);
		}
		emit_heap_slots_cleanup_for_return(status);
		status.code += `ldr x0, [sp], #16\n`;
		const match_saves = status.match_save_size || 0;
		if (match_saves > 0) {
			for (let i = 0; i < match_saves; i += 16) {
				status.code += `ldr x19, [sp], #16\n`;
			}
		}
		status.code += `b ${status.function_return_label}\n`;
	}
}
