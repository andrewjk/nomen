import type BuildStatus from "../build/BuildStatus.ts";
import type_from_value_node from "../build/utils/type_from_value_node.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessIndexNode from "../nodes/AccessIndexNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { allocate_stack_space, emit_var_address } from "./utils/stack_var.ts";
import { get_field_offset, get_struct_size } from "./utils/struct_layout.ts";

let access_temp_counter = 0;

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
	const target_type = type_from_value_node(node.target);
	const field_name = (node.access as AccessFieldNode).name;
	let offset = get_field_offset(target_type.name, field_name, status);

	// If target is another access node, add its offset
	if (node.target.node_type === "access") {
		const inner_access = node.target as AccessNode;
		if (inner_access.access.node_type === "access_field") {
			offset += compute_field_offset(inner_access, status);
		}
	}

	return offset;
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

	// Get base address into x0
	if (base.node_type === "value") {
		const name = (base as ValueNode).value;
		const paramReg = get_param_reg(name, status);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
			// if already x0, no-op
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(base, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	status.code += `ldr x0, [x0, #${offset}]\n`;
}

function build_access_method(
	node: AccessNode,
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
) {
	const target_type = type_from_value_node(node.target);
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
		status.code += `sub x8, x29, #${temp_offset}\n`;
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
			if (paramReg) {
				if (paramReg !== "x0") {
					status.code += `mov x0, ${paramReg}\n`;
				}
				// if already x0, no-op
			} else {
				emit_var_address(status, "x0", name);
			}
			if (target_is_simple) {
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
		} else {
			build_node(node.target, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			// For expression targets, the result is already a value, no need to load
		}
	}

	// Evaluate params
	const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	const start_idx = access_func.is_static ? 0 : 1;
	for (let i = access_func.params.length - 1; i >= 0; i--) {
		build_node(access_func.params[i], status);
		const reg = param_regs[start_idx + i];
		if (reg && reg !== "x0") {
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			status.code += `mov ${reg}, x0\n`;
		}
	}

	status.code += `bl ${method_name}\n`;

	if (return_struct) {
		status.code += `sub x0, x29, #${temp_offset}\n`;
	}
}

function build_access_index(node: AccessNode, access_index: AccessIndexNode, status: BuildStatus) {
	const target_type = type_from_value_node(node.target);
	const element_size = target_type.name ? aarch64_size(target_type.name) : 8;
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
