import type BuildStatus from "../build_c/BuildStatus.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { emit_address_of } from "./build_access_node.ts";
import build_node from "./build_node.ts";
import { emit_malloc } from "./utils/audit.ts";
import { mark_moved_if_struct, find_anchor_slot } from "./utils/auto_destroy.ts";
import { build_swap_params } from "./utils/build_swap.ts";
import {
	allocate_stack_space,
	emit_deref_var_address,
	emit_var_address,
	emit_var_load,
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
			const struct_size = get_struct_size(node.name, status);
			const offset = allocate_stack_space(status, struct_size);
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
		// Collect `ref` class args whose caller-side anchor must be re-synced to
		// the (possibly reassigned) slot value after the call returns.
		const ref_class_sync_names: string[] = [];

		if (variadic_idx !== undefined) {
			// Variadic call: pack variadic args into a stack array
			const arr = node.params[variadic_idx] as ArrayValuesNode;
			const elem_type_name = arr.type.name || "int";
			const elem_struct = status.structs.find(
				(s) => s.name === elem_type_name && !s.is_simple_type,
			);
			const elem_size = elem_struct ? get_struct_size(elem_type_name, status) : 8;
			const arr_offset = allocate_stack_space(status, arr.values.length * elem_size, 16);

			// Evaluate all variadic args and store on stack
			for (let j = arr.values.length - 1; j >= 0; j--) {
				const arg = arr.values[j];
				const slot_offset = arr_offset + j * elem_size;
				if (elem_struct && arg.node_type === "func_call") {
					// Tuple constructor: evaluate params into x1..x7 (right-to-left)
					// then set x0 to slot address and call _init
					const fc = arg as FunctionCallNode;
					const fc_param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
					for (let k = fc.params.length - 1; k >= 0; k--) {
						build_node(fc.params[k], status);
						if (!status.code.endsWith("\n")) status.code += "\n";
						status.code += `mov ${fc_param_regs[k]}, x0\n`;
					}
					status.code += `add x0, x29, #${slot_offset}\n`;
					status.code += `bl ${fc.name}_init\n`;
				} else if (elem_struct) {
					// Struct value: copy from where it lives into the slot
					emit_struct_address(arg, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `mov x1, x0\n`;
					status.code += `add x0, x29, #${slot_offset}\n`;
					for (let b = 0; b < elem_size; b += 8) {
						status.code += `ldr x2, [x1, #${b}]\n`;
						status.code += `str x2, [x0, #${b}]\n`;
					}
				} else {
					build_node(arr.values[j], status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `str x0, [x29, #${slot_offset}]\n`;
				}
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
			// Non-variadic call.
			// Evaluate each param into x0 and spill it to a dedicated stack
			// slot, then load all slots into argument registers right before the
			// call. Evaluating an argument expression can use x1..x7 as scratch
			// (e.g. binary operators hardcode x1/x2), so storing a result
			// directly into its target register would let a later argument
			// clobber an earlier one (e.g. `[a+1, a+2]` lost the second value).
			const has_args = node.params.length > 0;
			let args_base = 0;
			if (has_args) {
				args_base = allocate_stack_space(status, node.params.length * 8, 16);
			}
			// Evaluate params right-to-left, spilling each result to its slot.
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
				} else if (is_ref_param) {
					// A `ref` arg must pass the ADDRESS of the caller's slot so the
					// callee can reassign it. A CLASS local's slot holds the heap
					// pointer (it is an is_local_ref_var), so emit_address_of would
					// dereference it — pass the raw slot address instead so the
					// callee can store a new pointer back through it. A struct ref
					// local (e.g. `var ref Point p = a`) also is_local_ref_var, but
					// its slot holds a pointer to a struct that lives elsewhere; for
					// it the existing dereference (the struct's address) is correct,
					// so only divert class locals here.
					const arg = node.params[i];
					const arg_name = arg.node_type === "value" ? (arg as ValueNode).value : undefined;
					let arg_is_class = false;
					if (arg_name) {
						const tn = (arg as any).type?.name ?? status.variable_types?.get(arg_name)?.name;
						arg_is_class = !!tn && !!status.structs.find((s) => s.name === tn && s.is_class);
					}
					if (arg_name !== undefined && is_local_ref_var(arg_name, status) && arg_is_class) {
						emit_var_address(status, "x0", arg_name);
						ref_class_sync_names.push(arg_name);
					} else {
						emit_address_of(arg, status);
					}
				} else if (
					is_struct_type(param_type, status) ||
					is_enum_with_data_type(param_type, status)
				) {
					emit_struct_address(node.params[i], status);
				} else {
					build_node(node.params[i], status);
				}
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				status.code += `str x0, [x29, #${args_base + i * 8}]\n`;
			}
			// Load each spilled argument into its target register. For struct
			// constructors x0 is the destination (set up below), so it's never a
			// param target; for ordinary calls param 0 goes in x0.
			if (has_args) {
				for (let i = 0; i < node.params.length; i++) {
					const reg = param_regs[start_reg + i];
					if (reg === "x0") continue;
					status.code += `ldr ${reg}, [x29, #${args_base + i * 8}]\n`;
				}
				if (!is_struct) {
					status.code += `ldr x0, [x29, #${args_base}]\n`;
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

		// A `ref` class arg may have been reassigned by the callee, which wrote
		// the new pointer into the caller's slot. The caller's anchor slot (used
		// for cleanup at scope exit) still holds the old pointer — sync it to the
		// slot's current value so the new instance is freed once and the old one
		// (already freed by the callee) is not double-freed. If the callee did
		// not reassign, the slot is unchanged and this is a no-op. Preserve x0
		// across the sync — it holds the call's return value.
		if (ref_class_sync_names.some((n) => find_anchor_slot(status, n) !== undefined)) {
			status.code += `str x0, [sp, #-16]!\n`;
			for (const sync_name of ref_class_sync_names) {
				const anchor = find_anchor_slot(status, sync_name);
				if (anchor !== undefined) {
					emit_var_load(status, "x0", sync_name, 8);
					status.code += `str x0, [x29, #${anchor}]\n`;
				}
			}
			status.code += `ldr x0, [sp], #16\n`;
		}

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
