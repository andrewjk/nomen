import type BuildStatus from "../build/BuildStatus.ts";
import type_from_value_node from "../build/utils/type_from_value_node.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessIndexNode from "../nodes/AccessIndexNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_malloc } from "./utils/audit.ts";
import {
	allocate_stack_space,
	emit_deref_var_address,
	emit_var_address,
	is_local_ref_var,
} from "./utils/stack_var.ts";
import { get_field_offset, get_struct_size } from "./utils/struct_layout.ts";

let access_temp_counter = 0;

function is_struct_type(type_name: string, status: BuildStatus): boolean {
	return !!status.structs.find((s) => s.name === type_name && !s.is_simple_type);
}

export function reset_access_temp_counter() {
	access_temp_counter = 0;
}

export default function build_access_node(node: AccessNode, status: BuildStatus) {
	switch (node.access.node_type) {
		case "access_field": {
			build_access_field(node, status);
			break;
		}
		case "access_func": {
			const access_func = node.access as AccessFunctionCallNode;
			build_access_method(node, access_func, status);
			break;
		}
		case "access_index": {
			const access_index = node.access as AccessIndexNode;
			build_access_index(node, access_index, status);
			break;
		}
	}
}

function compute_field_offset(node: AccessNode, status: BuildStatus): number {
	if (node.access.node_type === "access_field") {
		const target_type = type_from_value_node(node.target);
		const field_name = (node.access as AccessFieldNode).name;
		let offset = get_field_offset(target_type.name, field_name, status);

		if (node.target.node_type === "access") {
			const inner_access = node.target as AccessNode;
			offset += compute_access_offset(inner_access, status);
		}

		return offset;
	}

	if (node.access.node_type === "access_index") {
		return compute_access_offset(node, status);
	}

	return 0;
}

function compute_access_offset(node: AccessNode, status: BuildStatus): number {
	if (node.access.node_type === "access_field") {
		return compute_field_offset(node, status);
	}

	if (node.access.node_type === "access_index") {
		const access_index = node.access as AccessIndexNode;
		const target_type = type_from_value_node(node.target);
		const struct_type = status.structs.find(
			(s) => s.name === target_type.name && !s.is_simple_type,
		);
		const element_size = struct_type
			? get_struct_size(target_type.name, status)
			: aarch64_size(target_type.name);

		let index_offset = 0;
		if (access_index.index.node_type === "value") {
			const index_val = (access_index.index as ValueNode).value;
			if (/^(\+|-)*\d+$/.test(index_val)) {
				index_offset = parseInt(index_val) * element_size;
			}
		}

		if (node.target.node_type === "access") {
			index_offset += compute_access_offset(node.target as AccessNode, status);
		}

		return index_offset;
	}

	return 0;
}

function get_base_target(node: AccessNode): ValueNode | AccessNode {
	if (node.target.node_type === "access") {
		return get_base_target(node.target as AccessNode);
	}
	return node.target as ValueNode;
}

function get_param_reg(name: string, status: BuildStatus): string | undefined {
	return status.function_param_regs?.get(name);
}

function build_access_field(node: AccessNode, status: BuildStatus) {
	const target_type = type_from_value_node(node.target);
	const access_field = node.access as AccessFieldNode;

	if (access_field.type?.name === "func") {
		status.code += `adr x0, ${target_type.name}_${access_field.name}\n`;
		return;
	}

	const enum_node = status.enums.find((e) => e.name === target_type.name);
	if (enum_node) {
		const enum_case = enum_node.cases.find((c) => c.name === access_field.name);
		if (enum_case) {
			if (enum_node.has_associated_data) {
				const case_index = enum_node.cases.indexOf(enum_case);
				status.code += `mov x0, #${case_index}\n`;
			} else {
				const case_index = enum_node.cases.indexOf(enum_case);
				status.code += `mov x0, #${case_index}\n`;
			}
			return;
		}
	}

	const bitset_node = status.bitsets.find((b) => b.name === target_type.name);
	if (bitset_node) {
		const case_index = bitset_node.cases.indexOf(access_field.name);
		if (case_index >= 0) {
			status.code += `mov x0, #(1 << ${case_index})\n`;
			return;
		}
	}

	if (target_type.is_array && access_field.name === "length") {
		const decl = status.scoped_declarations.find((d) => {
			if (node.target.node_type === "value") {
				return d.name === (node.target as ValueNode).value;
			}
			return false;
		});
		if (decl && decl.type.length) {
			const length_value = (decl.type.length as any).value || "0";
			status.code += `mov x0, #${length_value}\n`;
		} else if (decl && decl.value && decl.value.node_type === "array") {
			const count = (decl.value as any).values.length;
			status.code += `mov x0, #${count}\n`;
		} else {
			status.code += `mov x0, #0\n`;
		}
		return;
	}

	const offset = compute_field_offset(node, status);
	const base = get_base_target(node);

	const target_is_ref_access =
		node.target.node_type === "access" &&
		(node.target as AccessNode).access.node_type === "access_field" &&
		((node.target as AccessNode).access as AccessFieldNode).type?.is_ref;

	if (target_is_ref_access) {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		const final_offset = get_field_offset(access_field.type?.name || "", access_field.name, status);
		const field_type = access_field.type?.name || "";
		const size = aarch64_size(field_type);
		const signed =
			field_type.startsWith("int") ||
			field_type === "float" ||
			field_type === "float32" ||
			field_type === "float64";
		if (size === 1) {
			status.code += signed
				? `ldrsb x0, [x0, #${final_offset}]\n`
				: `ldrb w0, [x0, #${final_offset}]\n`;
		} else if (size === 4) {
			status.code += signed
				? `ldrsw x0, [x0, #${final_offset}]\n`
				: `ldr w0, [x0, #${final_offset}]\n`;
		} else {
			status.code += `ldr x0, [x0, #${final_offset}]\n`;
		}
		return;
	}

	// Get base address into x0
	if (base.node_type === "value") {
		const name = (base as ValueNode).value;
		const paramReg = get_param_reg(name, status);
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
		build_node(base, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	const field_type = access_field.type?.name || "";
	const size = aarch64_size(field_type);
	const signed =
		field_type.startsWith("int") ||
		field_type === "float" ||
		field_type === "float32" ||
		field_type === "float64";
	if (size === 1) {
		status.code += signed ? `ldrsb x0, [x0, #${offset}]\n` : `ldrb w0, [x0, #${offset}]\n`;
	} else if (size === 4) {
		status.code += signed ? `ldrsw x0, [x0, #${offset}]\n` : `ldr w0, [x0, #${offset}]\n`;
	} else {
		status.code += `ldr x0, [x0, #${offset}]\n`;
	}
}

function build_access_method(
	node: AccessNode,
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
) {
	const target_type = type_from_value_node(node.target);

	const enum_node = status.enums.find((e) => e.name === target_type.name);
	if (enum_node) {
		const enum_case = enum_node.cases.find((c) => c.name === access_func.name);
		if (enum_case) {
			const case_index = enum_node.cases.indexOf(enum_case);
			status.code += `mov x0, #${case_index}\n`;
			return;
		}
	}

	if (
		access_func.name === "to_string" &&
		(status.enums.find((e) => e.name === target_type.name) ||
			status.bitsets.find((b) => b.name === target_type.name))
	) {
		if (node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			const paramReg = get_param_reg(name, status);
			if (paramReg) {
				if (paramReg !== "x0") {
					status.code += `mov x0, ${paramReg}\n`;
				}
			} else {
				emit_var_address(status, "x0", name);
			}
			status.code += `ldr x0, [x0]\n`;
		} else {
			build_node(node.target, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}
		status.code += `bl int_to_string\n`;
		return;
	}

	if (
		access_func.name === "to_string" &&
		target_type.is_array &&
		target_type.name === "char" &&
		target_type.length
	) {
		build_char_array_to_string(node, (target_type.length as ValueNode).value, status);
		return;
	}

	if (access_func.name === "to_string" && target_type.is_array && target_type.length) {
		build_int_array_to_string(node, target_type, status);
		return;
	}

	const method_name = `${target_type.name}_${access_func.name}`;

	// Check if method returns a struct
	const return_struct = status.structs.find(
		(s) => s.name === access_func.type.name && !s.is_simple_type,
	);

	let temp_addr = "";
	let temp_offset = 0;
	if (return_struct) {
		temp_addr = `_access_temp_${access_temp_counter++}`;
		temp_offset = allocate_stack_space(status, get_struct_size(access_func.type.name, status));
		status.stack_offsets!.set(temp_addr, temp_offset);
		status.code += `add x8, x29, #${temp_offset}\n`;
	}

	if (!access_func.is_static) {
		// Instance method: load target into x0 (self)
		// For simple types, pass value; for structs, pass address
		const target_is_simple = !status.structs.find(
			(s) => s.name === target_type.name && !s.is_simple_type,
		);
		if (node.target.node_type === "value") {
			const name = (node.target as ValueNode).value;
			const paramReg = get_param_reg(name, status);
			const is_literal_value =
				/^(\+|-)?\d+(\.\d+)?$/.test(name) || name === "true" || name === "false";
			if (paramReg) {
				if (paramReg !== "x0") {
					status.code += `mov x0, ${paramReg}\n`;
				}
			} else if (is_literal_value || (name.startsWith("'") && name.endsWith("'"))) {
				build_node(node.target, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
			} else {
				const has_stack_offset = status.stack_offsets?.has(name);
				if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x0", name);
				} else {
					emit_var_address(status, "x0", name);
				}
				if (
					target_is_simple &&
					(target_type.name !== "string" || has_stack_offset) &&
					!is_local_ref_var(name, status)
				) {
					const size = aarch64_size(target_type.name);
					const signed =
						target_type.name.startsWith("int") ||
						target_type.name === "float" ||
						target_type.name === "float32" ||
						target_type.name === "float64";
					if (size === 1) {
						status.code += signed ? `ldrsb x0, [x0]\n` : `ldrb w0, [x0]\n`;
					} else if (size === 4) {
						status.code += signed ? `ldrsw x0, [x0]\n` : `ldr w0, [x0]\n`;
					} else {
						status.code += `ldr x0, [x0]\n`;
					}
				}
			}
		} else {
			build_node(node.target, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			// For expression targets, the result is already a value, no need to load
		}
	}

	const needs_self_save = !access_func.is_static && access_func.params.length > 0;
	if (needs_self_save) {
		status.code += `str x0, [sp, #-16]!\n`;
	}

	// Evaluate params
	const param_regs = access_func.is_static
		? ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"]
		: ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	const start_idx = 0;
	for (let i = access_func.params.length - 1; i >= 0; i--) {
		const param = access_func.params[i];
		const is_ref_param = access_func.ref_param_indices?.includes(i);
		const param_type = (param as any).type?.name || "";
		const is_struct = is_struct_type(param_type, status);
		if (is_ref_param) {
			if (param.node_type === "value") {
				const name = (param as ValueNode).value;
				if (is_local_ref_var(name, status)) {
					emit_deref_var_address(status, "x0", name);
				} else {
					emit_var_address(status, "x0", name);
				}
			} else {
				build_node(param, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
			}
		} else if (is_struct) {
			if (param.node_type === "value") {
				const name = (param as ValueNode).value;
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
				build_node(param, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
			}
		} else {
			build_node(param, status);
		}
		const reg = param_regs[start_idx + i];
		if (reg && reg !== "x0") {
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			status.code += `mov ${reg}, x0\n`;
		}
	}

	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
	if (needs_self_save) {
		status.code += `ldr x0, [sp], #16\n`;
	}

	status.code += `bl ${method_name}\n`;

	if (method_name.endsWith("_to_string") && method_name !== "string_to_string") {
		status.last_result_is_heap = true;
	}

	if (return_struct) {
		status.code += `add x0, x29, #${temp_offset}\n`;
	}
}

function build_access_index(node: AccessNode, access_index: AccessIndexNode, status: BuildStatus) {
	const target_type = type_from_value_node(node.target);
	const is_string = target_type.name === "string";
	const struct_type = status.structs.find((s) => s.name === target_type.name && !s.is_simple_type);
	const element_size = is_string
		? 1
		: struct_type
			? get_struct_size(target_type.name, status)
			: target_type.name
				? aarch64_size(target_type.name)
				: 8;
	const element_signed =
		target_type.name && (target_type.name.startsWith("int") || target_type.name === "float");

	// Get base address
	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}
	status.code += `mov x3, x0\n`;

	// Evaluate index
	if (access_index.index.node_type === "value") {
		const index_val = (access_index.index as ValueNode).value;
		if (/^(\+|-)*\d+$/.test(index_val)) {
			const offset = parseInt(index_val) * element_size;
			if (element_size === 1) {
				status.code += element_signed
					? `ldrsb x0, [x3, #${offset}]\n`
					: `ldrb w0, [x3, #${offset}]\n`;
			} else if (element_size === 4) {
				status.code += element_signed
					? `ldrsw x0, [x3, #${offset}]\n`
					: `ldr w0, [x3, #${offset}]\n`;
			} else {
				status.code += `ldr x0, [x3, #${offset}]\n`;
			}
			return;
		}
	}

	build_node(access_index.index, status);
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
	status.code += `mov x1, x0\n`;
	status.code += `mov x2, #${element_size}\n`;
	status.code += `mul x1, x1, x2\n`;
	status.code += `add x0, x3, x1\n`;
	if (element_size === 1) {
		status.code += element_signed ? `ldrsb x0, [x0]\n` : `ldrb w0, [x0]\n`;
	} else if (element_size === 4) {
		status.code += element_signed ? `ldrsw x0, [x0]\n` : `ldr w0, [x0]\n`;
	} else {
		status.code += `ldr x0, [x0]\n`;
	}
}

function build_int_array_to_string(node: AccessNode, target_type: Type, status: BuildStatus) {
	const length = parseInt((target_type.length as ValueNode).value);
	const element_size = aarch64_size(target_type.name);

	// Get array base address into x19
	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	// Save x19, x20
	status.code += `str x19, [sp, #-16]!\n`;
	status.code += `str x20, [sp, #-16]!\n`;
	status.code += `mov x19, x0\n`;

	// Allocate result buffer - estimate 20 bytes per int element
	const buf_size = Math.max(length * 20, 32);
	status.code += `mov x0, #${buf_size}\n`;
	emit_malloc(status);
	status.code += `mov x20, x0\n`;

	// Zero out the buffer
	status.code += `strb wzr, [x20]\n`;

	// Loop through elements
	for (let i = 0; i < length; i++) {
		// Load element
		const offset = i * element_size;
		if (element_size === 1) {
			status.code += `ldrb w0, [x19, #${offset}]\n`;
			status.code += `uxtb w0, w0\n`;
		} else {
			status.code += `ldr x0, [x19, #${offset}]\n`;
		}

		// Call int_to_string (or appropriate to_string)
		const to_string_fn = `${target_type.name}_to_string`;
		status.code += `bl ${to_string_fn}\n`;

		// Concatenate: strcat(x20, x0)
		status.code += `mov x1, x0\n`;
		status.code += `mov x0, x20\n`;
		status.code += `bl _strcat\n`;
	}

	// Return result in x0
	status.code += `mov x0, x20\n`;
	status.code += `ldr x20, [sp], #16\n`;
	status.code += `ldr x19, [sp], #16\n`;
}

function build_char_array_to_string(node: AccessNode, length: string, status: BuildStatus) {
	const len = parseInt(length);

	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	status.code += `str x19, [sp, #-16]!\n`;
	status.code += `mov x19, x0\n`;
	status.code += `mov x0, #${len + 1}\n`;
	emit_malloc(status);

	for (let i = 0; i < len; i++) {
		status.code += `ldrb w1, [x19, #${i}]\n`;
		status.code += `strb w1, [x0, #${i}]\n`;
	}
	status.code += `strb wzr, [x0, #${len}]\n`;
	status.code += `ldr x19, [sp], #16\n`;
}
