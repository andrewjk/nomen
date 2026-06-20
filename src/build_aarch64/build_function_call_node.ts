import type BuildStatus from "../build_c/BuildStatus.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { emit_address_of } from "./build_access_node.ts";
import build_node from "./build_node.ts";
import { emit_malloc } from "./utils/audit.ts";
import { mark_moved_if_struct } from "./utils/auto_destroy.ts";
import { build_swap_params } from "./utils/build_swap.ts";
import {
	allocate_stack_space,
	emit_deref_var_address,
	emit_var_address,
	is_local_ref_var,
} from "./utils/stack_var.ts";
import { get_struct_size } from "./utils/struct_layout.ts";

let temp_counter = 0;

export function reset_temp_counter() {
	temp_counter = 0;
	array_param_counter = 0;
}

function is_struct_type(type_name: string, status: BuildStatus): boolean {
	return !!status.structs.find((s) => s.name === type_name && !s.is_simple_type);
}

function is_enum_with_data_type(type_name: string, status: BuildStatus): boolean {
	const e = status.enums.find((e) => e.name === type_name);
	return !!e && !!e.has_associated_data;
}

function get_raw_value(node: ValueNode, status?: BuildStatus): string {
	let val = node.value;
	if (val === "true") return "1";
	if (val === "false") return "0";
	if (node.is_enum_shorthand && status) {
		const enum_node = status.enums.find((e) => val.startsWith(e.name + "_"));
		if (enum_node) {
			const case_name = val.substring(enum_node.name.length + 1);
			const case_index = enum_node.cases.findIndex((c) => c.name === case_name);
			if (case_index >= 0) return String(case_index);
		}
	}
	if (val.startsWith("0x") || val.startsWith("0X"))
		return String(parseInt(val.replace(/_/g, ""), 16));
	if (val.startsWith("0o") || val.startsWith("0O"))
		return String(parseInt(val.replace(/_/g, ""), 8));
	if (val.startsWith("0b") || val.startsWith("0B"))
		return String(parseInt(val.replace(/_/g, ""), 2));
	return val;
}

let array_param_counter = 0;

function emit_struct_address(node: BaseNode, status: BuildStatus) {
	if (node.node_type === "value") {
		const name = (node as any).value;
		const paramReg = status.function_param_regs?.get(name);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else if (is_local_ref_var(name, status)) {
			emit_deref_var_address(status, "x0", name);
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}
}

export default function build_function_call_node(node: FunctionCallNode, status: BuildStatus) {
	const is_struct = status.structs.find((s) => s.name === node.name && !s.is_simple_type);
	const func_name = is_struct ? `${node.name}_init` : node.name;
	const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];

	let start_reg = 0;

	if (is_struct) {
		if (is_struct.is_class) {
			const struct_size = get_struct_size(node.name, status);
			status.code += `mov x0, #${struct_size}\n`;
			emit_malloc(status);
			status.code += `str x0, [sp, #-16]!\n`;
		} else if (status.struct_return_buffer) {
			status.code += `mov x0, ${status.struct_return_buffer}\n`;
		} else {
			const dest_addr = `_temp_${temp_counter++}`;
			const offset = allocate_stack_space(status, 16);
			status.stack_offsets!.set(dest_addr, offset);
		}
		start_reg = 1;
	}

	if (node.is_func_param) {
		// Load function pointer from stack
		const func_offset = status.stack_offsets?.get(node.name);
		if (func_offset !== undefined) {
			status.code += `ldr x8, [x29, #${func_offset}]\n`;
		} else {
			const paramReg = status.function_param_regs?.get(node.name);
			if (paramReg) {
				status.code += `mov x8, ${paramReg}\n`;
			} else {
				status.code += `adr x8, ${node.name}\n`;
			}
		}

		// Evaluate params right-to-left
		for (let i = node.params.length - 1; i >= 0; i--) {
			build_node(node.params[i], status);
			const reg = param_regs[start_reg + i];
			if (reg !== "x0") {
				status.code += `\nmov ${reg}, x0\n`;
			} else {
				status.code += `\n`;
			}
		}

		status.code += `blr x8\n`;
	} else {
		const variadic_idx = (node as FunctionCallNode).variadic_param_index;

		if (variadic_idx !== undefined) {
			// Variadic call: pack variadic args into a stack array
			const arr = node.params[variadic_idx] as ArrayValuesNode;
			const elem_size = 8;
			const arr_offset = allocate_stack_space(status, arr.values.length * elem_size, 16);

			// Evaluate all variadic args and store on stack
			for (let j = arr.values.length - 1; j >= 0; j--) {
				build_node(arr.values[j], status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				const slot_offset = arr_offset + j * elem_size;
				status.code += `str x0, [x29, #${slot_offset}]\n`;
			}

			// Evaluate non-variadic params right-to-left (they come after variadic in the call)
			const non_variadic: { node: BaseNode; is_struct: boolean; is_ref: boolean }[] = [];
			for (let i = 0; i < node.params.length; i++) {
				if (i === variadic_idx) continue;
				const param = node.params[i];
				const param_type = (param as any).type?.name || "";
				const is_ref_param = node.ref_param_indices?.includes(i);
				non_variadic.push({
					node: param,
					is_struct:
						is_struct_type(param_type, status) || is_enum_with_data_type(param_type, status),
					is_ref: !!is_ref_param,
				});
			}
			// Set up array pointer
			status.code += `add x0, x29, #${arr_offset}\n`;
			const ptr_reg = param_regs[start_reg + non_variadic.length + 1];
			if (ptr_reg !== "x0") {
				status.code += `mov ${ptr_reg}, x0\n`;
			}

			// Set up count (after pointer to avoid clobbering x0)
			const count_reg = param_regs[start_reg + non_variadic.length];
			status.code += `mov ${count_reg}, #${arr.values.length}\n`;

			// Evaluate non-variadic params right-to-left (after count/pointer so they go into x0, x1, etc. without being clobbered)
			for (let i = non_variadic.length - 1; i >= 0; i--) {
				const ep = non_variadic[i];
				if (ep.is_struct) {
					emit_struct_address(ep.node, status);
				} else if (ep.is_ref) {
					emit_address_of(ep.node, status);
				} else {
					build_node(ep.node, status);
				}
				if (!status.code.endsWith("\n")) status.code += "\n";
				const reg_idx = start_reg + i;
				const reg = param_regs[reg_idx];
				if (reg && reg !== "x0") {
					status.code += `mov ${reg}, x0\n`;
				}
			}
		} else {
			// Non-variadic call: original logic
			// Evaluate params right-to-left to avoid clobbering
			for (let i = node.params.length - 1; i >= 0; i--) {
				const param = node.params[i];
				const param_type = (param as any).type?.name || "";
				const is_ref_param = node.ref_param_indices?.includes(i);
				if (param.node_type === "array" && param_type) {
					const arr = param as ArrayValuesNode;
					const label = `_arr_param_${array_param_counter++}`;
					const has_strings = arr.values.some(
						(v) => v.node_type === "value" && (v as ValueNode).value.startsWith('"'),
					);
					if (has_strings) {
						const str_labels: string[] = [];
						arr.values.forEach((v, idx) => {
							if (v.node_type === "value" && (v as ValueNode).value.startsWith('"')) {
								const str_label = `_arr_str_${array_param_counter++}_${idx}`;
								status.code += `${str_label}: .asciz ${(v as ValueNode).value}\n.p2align 2\n`;
								str_labels.push(str_label);
							} else {
								str_labels.push(get_raw_value(v as ValueNode, status));
							}
						});
						status.code += `${label}: .quad ${str_labels.join(", ")}\n.p2align 2\n`;
					} else {
						const values = arr.values
							.map((v) => (v.node_type === "value" ? get_raw_value(v as ValueNode, status) : "0"))
							.join(", ");
						status.code += `${label}: .quad ${values}\n.p2align 2\n`;
					}
					status.code += `adr x0, ${label}`;
				} else if (
					is_struct_type(param_type, status) ||
					is_enum_with_data_type(param_type, status)
				) {
					emit_struct_address(node.params[i], status);
				} else if (is_ref_param) {
					emit_address_of(node.params[i], status);
				} else {
					build_node(node.params[i], status);
				}
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				const reg = param_regs[start_reg + i];
				if (reg !== "x0") {
					status.code += `mov ${reg}, x0\n`;
				}
			}
		}

		if (is_struct && status.struct_return_buffer) {
			status.code += `mov x0, ${status.struct_return_buffer}\n`;
		} else if (is_struct && is_struct.is_class) {
			status.code += `ldr x0, [sp]\n`;
		} else if (is_struct && !is_struct.is_class) {
			const temp_addr = `_temp_${temp_counter - 1}`;
			const temp_offset = status.stack_offsets!.get(temp_addr)!;
			status.code += `add x0, x29, #${temp_offset}\n`;
		} else if (!is_struct && node.type?.name && !status.struct_return_buffer) {
			const return_struct = status.structs.find(
				(s) => s.name === node.type!.name && !s.is_simple_type && !s.is_class,
			);
			if (return_struct) {
				const struct_size = get_struct_size(node.type!.name, status);
				const temp_name = `_call_ret_${temp_counter++}`;
				const offset = allocate_stack_space(status, struct_size);
				status.stack_offsets!.set(temp_name, offset);
				status.code += `add x8, x29, #${offset}\n`;
			}
		}

		status.code += `bl ${func_name}\n`;

		if (!is_struct && node.type?.name && !status.struct_return_buffer) {
			const return_struct = status.structs.find(
				(s) => s.name === node.type!.name && !s.is_simple_type && !s.is_class,
			);
			if (return_struct) {
				const temp_name = `_call_ret_${temp_counter - 1}`;
				const offset = status.stack_offsets!.get(temp_name)!;
				status.code += `add x0, x29, #${offset}\n`;
			}
		}
	}

	build_swap_params(node, status);

	// For struct constructors with a temp, load temp address into x0
	if (is_struct && !status.struct_return_buffer) {
		if (is_struct.is_class) {
			status.code += `ldr x0, [sp], #16\n`;
		} else {
			const temp_addr = `_temp_${temp_counter - 1}`;
			const offset = status.stack_offsets!.get(temp_addr)!;
			status.code += `add x0, x29, #${offset}\n`;
		}
	}

	if (node.name.startsWith("_string_interpolate_")) {
		status.interpolate_string_counts.add(node.params.length - 1);
		status.last_result_is_heap = true;
	}

	if (status.heap_returning_functions?.has(node.name)) {
		status.last_result_is_heap = true;
	}

	if (node.mov_param_indices?.length) {
		for (const idx of node.mov_param_indices) {
			const param = node.params[idx];
			if (param) {
				mark_moved_if_struct(param, status);
			}
		}
	}
}
