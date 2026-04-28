import type BuildStatus from "../build/BuildStatus.ts";
import type_from_value_node from "../build/utils/type_from_value_node.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
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

export default function build_assignment_node(node: AssignmentNode, status: BuildStatus) {
	if (node.left_value.node_type === "value") {
		const name = (node.left_value as ValueNode).value;
		const paramReg = status.function_param_regs?.get(name);
		const size = find_var_size(name, status);
		const store_op = get_store_instruction(size);
		const store_reg = get_store_reg("x0", size);
		if (paramReg) {
			if (status.function_param_vars?.has(name)) {
				// var param - address in register, store value
				status.code += `mov x2, ${paramReg}\n`;
				build_node(node.right_value, status);
				status.code += `\n${store_op} ${store_reg}, [x2]\n`;
			} else {
				// const param - can't assign
				build_node(node.right_value, status);
				status.code += `\n// cannot assign to const param\n`;
			}
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

			// Evaluate RHS
			build_node(node.right_value, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			status.code += `mov x2, x0\n`;

			// Get base address - for value targets, just use adr; for others, build_node
			if (access.target.node_type === "value") {
				const name = (access.target as ValueNode).value;
				const paramReg = status.function_param_regs?.get(name);
				if (paramReg) {
					if (name === "self" || name === "_self") {
						// self is already the struct address in x0
						// but x0 might have been overwritten by RHS evaluation
						// x2 has the RHS value, so we can use x0 for the address
						if (paramReg !== "x0") {
							status.code += `mov x0, ${paramReg}\n`;
						}
					} else if (status.function_param_vars?.has(name)) {
						// var param contains address
						status.code += `mov x0, ${paramReg}\n`;
					} else {
						// const param contains value, not address - can't assign to field
						status.code += `// cannot assign to field of value param\n`;
						return;
					}
				} else {
					emit_var_address(status, "x0", name);
				}
			} else {
				build_node(access.target, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
			}

			status.code += `str x2, [x0, #${offset}]\n`;
		} else {
			build_node(node.right_value, status);
			status.code += `\n// complex assignment\n`;
		}
	} else {
		build_node(node.right_value, status);
		status.code += `\n// complex assignment\n`;
	}
}
