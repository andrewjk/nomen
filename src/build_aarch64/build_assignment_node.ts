import type BuildStatus from "../build/BuildStatus.ts";
import type_from_value_node from "../build/utils/type_from_value_node.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessIndexNode from "../nodes/AccessIndexNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_var_address } from "./utils/stack_var.ts";
import { get_field_offset } from "./utils/struct_layout.ts";

function get_store_instruction(size: number): string {
	if (size === 1) return "strb";
	if (size === 4) return "str";
	return "str";
}

function get_store_reg(reg: string, size: number): string {
	if (size === 1 || size === 4) return reg.replace("x", "w");
	return reg;
}

function find_var_size(name: string, status: BuildStatus): number {
	const decl = status.scoped_declarations.find((d) => d.name === name);
	if (decl) return aarch64_size(decl.type.name);
	return 8;
}

function get_load_instruction(size: number): string {
	if (size === 1) return "ldrb";
	if (size === 4) return "ldr";
	return "ldr";
}

function get_load_reg(reg: string, size: number): string {
	if (size === 1 || size === 4) return reg.replace("x", "w");
	return reg;
}

function emit_compound_op(op: string, status: BuildStatus) {
	if (op === "+=") status.code += `add x0, x1, x0\n`;
	else if (op === "-=") status.code += `sub x0, x1, x0\n`;
	else if (op === "*=") status.code += `mul x0, x1, x0\n`;
}

function get_base_address(access: AccessNode, status: BuildStatus, reg: string) {
	if (access.target.node_type === "value") {
		const name = (access.target as ValueNode).value;
		const paramReg = status.function_param_regs?.get(name);
		if (paramReg) {
			if (paramReg !== reg) {
				status.code += `mov ${reg}, ${paramReg}\n`;
			}
		} else {
			emit_var_address(status, reg, name);
		}
	} else {
		build_node(access.target, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		if (reg !== "x0") {
			status.code += `mov ${reg}, x0\n`;
		}
	}
}

export default function build_assignment_node(node: AssignmentNode, status: BuildStatus) {
	if (node.left_value.node_type === "value") {
		const name = (node.left_value as ValueNode).value;
		const paramReg = status.function_param_regs?.get(name);
		const size = find_var_size(name, status);
		const store_op = get_store_instruction(size);
		const store_reg = get_store_reg("x0", size);
		if (paramReg) {
			if (status.function_param_vars?.has(name)) {
				status.code += `mov x2, ${paramReg}\n`;
				build_node(node.right_value, status);
				if (node.operator) {
					status.code += `\nstr x0, [sp, #-16]!\n`;
					const load_op = get_load_instruction(size);
					const load_reg = get_load_reg("x1", size);
					status.code += `${load_op} ${load_reg}, [x2]\n`;
					status.code += `mov x1, x0\n`;
					status.code += `ldr x0, [sp], #16\n`;
					emit_compound_op(node.operator, status);
				}
				status.code += `\n${store_op} ${store_reg}, [x2]\n`;
			} else {
				build_node(node.right_value, status);
				status.code += `\n// cannot assign to const param\n`;
			}
		} else if (node.operator) {
			emit_var_address(status, "x1", name);
			const load_op = get_load_instruction(size);
			const load_reg = get_load_reg("x1", size);
			status.code += `${load_op} ${load_reg}, [x1]\n`;
			status.code += `str x1, [sp, #-16]!\n`;
			build_node(node.right_value, status);
			status.code += `\n`;
			status.code += `ldr x1, [sp], #16\n`;
			emit_compound_op(node.operator, status);
			emit_var_address(status, "x1", name);
			status.code += `${store_op} ${store_reg}, [x1]\n`;
		} else {
			build_node(node.right_value, status);
			status.code += `\n`;
			emit_var_address(status, "x1", name);
			status.code += `${store_op} ${store_reg}, [x1]\n`;
		}
	} else if (node.left_value.node_type === "access") {
		const access = node.left_value as AccessNode;
		if (access.access.node_type === "access_field") {
			const field_name = (access.access as AccessFieldNode).name;
			const target_type = type_from_value_node(access.target);
			const offset = get_field_offset(target_type.name, field_name, status);

			if (access.target.node_type === "value") {
				const name = (access.target as ValueNode).value;
				const paramReg = status.function_param_regs?.get(name);
				if (paramReg && name !== "self" && !status.function_param_vars?.has(name)) {
					status.code += `// cannot assign to field of value param\n`;
					return;
				}
			}

			get_base_address(access, status, "x0");
			status.code += `str x0, [sp, #-16]!\n`;

			build_node(node.right_value, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			status.code += `mov x2, x0\n`;
			status.code += `ldr x0, [sp], #16\n`;

			status.code += `str x2, [x0, #${offset}]\n`;
		} else if (access.access.node_type === "access_index") {
			const access_index = access.access as AccessIndexNode;
			const target_type = type_from_value_node(access.target);
			const element_size = target_type.name ? aarch64_size(target_type.name) : 8;

			if (access.target.node_type === "value") {
				const name = (access.target as ValueNode).value;
				emit_var_address(status, "x3", name);
			} else {
				build_node(access.target, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				status.code += `mov x3, x0\n`;
			}

			if (access_index.index.node_type === "value") {
				const index_val = (access_index.index as ValueNode).value;
				if (/^(\+|-)*\d+$/.test(index_val)) {
					const byte_offset = parseInt(index_val) * element_size;

					status.code += `str x3, [sp, #-16]!\n`;

					build_node(node.right_value, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}

					status.code += `ldr x3, [sp], #16\n`;

					if (element_size === 1) {
						status.code += `strb w0, [x3, #${byte_offset}]\n`;
					} else if (element_size === 4) {
						status.code += `str w0, [x3, #${byte_offset}]\n`;
					} else {
						status.code += `str x0, [x3, #${byte_offset}]\n`;
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
			status.code += `add x3, x3, x1\n`;

			status.code += `str x3, [sp, #-16]!\n`;

			build_node(node.right_value, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}

			status.code += `ldr x3, [sp], #16\n`;

			if (element_size === 1) {
				status.code += `strb w0, [x3]\n`;
			} else if (element_size === 4) {
				status.code += `str w0, [x3]\n`;
			} else {
				status.code += `str x0, [x3]\n`;
			}
		} else {
			build_node(node.right_value, status);
			status.code += `\n// complex assignment\n`;
		}
	} else {
		build_node(node.right_value, status);
		status.code += `\n// complex assignment\n`;
	}
}
