import type BuildStatus from "../build/BuildStatus.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_array_values_node from "./build_array_values_node.ts";
import build_node from "./build_node.ts";
import build_range_node from "./build_range_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import aarch64_type from "./utils/aarch64_type.ts";
import { allocate_stack_space, emit_var_address, emit_var_store } from "./utils/stack_var.ts";
import { get_struct_size } from "./utils/struct_layout.ts";

function get_raw_value(node: ValueNode): string {
	let val = node.value;
	if (val === "true") return "1";
	if (val === "false") return "0";
	return val;
}

function emit_data(status: BuildStatus, data: string) {
	if (status.function_return_label) {
		if (!status.function_data) status.function_data = "";
		status.function_data += data;
	} else {
		status.code += data;
	}
}

export default function build_declaration_node(node: DeclarationNode, status: BuildStatus) {
	// Function type declaration
	if (node.func_params) {
		if (node.value && node.value.node_type === "func") {
			build_node(node.value, status);
		} else {
			// Function pointer - allocate on stack if in function, else global data
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, 8);
				status.stack_offsets!.set(node.name, offset);
			} else {
				emit_data(status, `${node.name}: .space 8`);
			}
		}
		return;
	}

	status.scoped_declarations.push(node);

	const directive = aarch64_type(node.type.name);
	const size = aarch64_size(node.type.name);

	// Check if type is a struct
	const struct_type = status.structs.find((s) => s.name === node.type.name && !s.is_simple_type);

	if (node.type.is_array) {
		if (node.value && node.value.node_type === "array") {
			status.code += `${node.name}: ${directive} `;
			build_array_values_node(node.value as ArrayValuesNode, status);
		} else if (node.value && node.value.node_type === "range") {
			status.code += `${node.name}: ${directive} `;
			build_range_node(node.value as RangeNode, status);
		} else {
			status.code += `${node.name}: .space 0`;
		}
	} else if (struct_type) {
		// Struct declaration
		const struct_size = get_struct_size(node.type.name, status);
		if (status.function_return_label) {
			const offset = allocate_stack_space(status, struct_size);
			status.stack_offsets!.set(node.name, offset);
		} else {
			emit_data(status, `${node.name}: .space ${struct_size}\n`);
		}
		if (node.value && node.value.node_type === "func_call") {
			const func_call = node.value as FunctionCallNode;
			const is_constructor = status.structs.find(
				(s) => s.name === func_call.name && !s.is_simple_type,
			);
			if (is_constructor) {
				// Evaluate params into x1-x7 first (before setting x0)
				const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
				for (let i = func_call.params.length - 1; i >= 0; i--) {
					build_node(func_call.params[i], status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					status.code += `mov ${param_regs[i]}, x0\n`;
				}
				// Pass declaration address in x0
				emit_var_address(status, "x0", node.name);
				status.code += `bl ${func_call.name}_init\n`;
			} else {
				build_node(node.value, status);
				emit_var_store(status, "x0", node.name, struct_size);
			}
		} else if (node.value) {
			build_node(node.value, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			// Copy struct data from returned address in x0 to declaration
			status.code += `mov x1, x0\n`;
			emit_var_address(status, "x2", node.name);
			const words = Math.ceil(struct_size / 8);
			for (let i = 0; i < words; i++) {
				status.code += `ldr x3, [x1, #${i * 8}]\n`;
				status.code += `str x3, [x2, #${i * 8}]\n`;
			}
		}
	} else if (node.value) {
		if (node.value.node_type === "value") {
			const raw = get_raw_value(node.value as ValueNode);
			const use_stack = status.function_return_label && node.declaration === "var";
			if (use_stack) {
				const offset = allocate_stack_space(status, size, size);
				status.stack_offsets!.set(node.name, offset);
				if (node.type.name === "float") {
					const label = `_float_const_${node.name}`;
					emit_data(status, `${label}: .double ${raw}\n.p2align 2\n`);
					status.code += `adr x0, ${label}\n`;
					status.code += `ldr d0, [x0]\n`;
					status.code += `str d0, [x29, #${offset}]\n`;
				} else {
					status.code += `mov x0, #${raw}\n`;
					if (size === 1) {
						status.code += `strb w0, [x29, #${offset}]\n`;
					} else if (size === 4) {
						status.code += `str w0, [x29, #${offset}]\n`;
					} else {
						status.code += `str x0, [x29, #${offset}]\n`;
					}
				}
			} else {
				emit_data(status, `${node.name}: ${directive} ${raw}\n`);
				if (size % 4 !== 0) {
					emit_data(status, `.p2align 2\n`);
				}
			}
		} else if (node.value.node_type === "array") {
			status.code += `${node.name}: ${directive} `;
			build_array_values_node(node.value as ArrayValuesNode, status);
			status.code += `\n`;
		} else if (node.value.node_type === "range") {
			status.code += `${node.name}: ${directive} `;
			build_range_node(node.value as RangeNode, status);
			status.code += `\n`;
		} else if (node.value.node_type === "if") {
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, size, size);
				status.stack_offsets!.set(node.name, offset);
			} else {
				emit_data(status, `${node.name}: .space ${size}\n`);
			}
			const old_return_assign = status.return_assign;
			status.return_assign = node.name;
			build_node(node.value, status);
			status.return_assign = old_return_assign;
		} else {
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, size, size);
				status.stack_offsets!.set(node.name, offset);
			} else {
				emit_data(status, `${node.name}: .space ${size}\n`);
			}
			build_node(node.value, status);
			emit_var_store(status, "x0", node.name, size);
		}
	} else {
		const use_stack = status.function_return_label && node.declaration === "var";
		if (use_stack) {
			const offset = allocate_stack_space(status, size, size);
			status.stack_offsets!.set(node.name, offset);
		} else {
			emit_data(status, `${node.name}: .space ${size}\n`);
			if (size % 4 !== 0) {
				emit_data(status, `.p2align 2\n`);
			}
		}
	}
}
