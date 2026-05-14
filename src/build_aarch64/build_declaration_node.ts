import type BuildStatus from "../build/BuildStatus.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import OperationNode from "../nodes/OperationNode.ts";

function escape_asciz(value: string): string {
	if (!value.includes("\n")) return value;
	const quote = value[0];
	const content = value.slice(1, value.endsWith(quote) ? -1 : undefined);
	return quote + content.replace(/\n/g, "\\n") + (value.endsWith(quote) ? quote : "");
}
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
	if (val.startsWith("'") && val.endsWith("'") && val.length === 3) {
		return val.charCodeAt(1).toString();
	}
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

function resolve_array_values(node: any, status: BuildStatus): string[] | null {
	if (node.node_type === "array") {
		return (node as ArrayValuesNode).values
			.map((v) => {
				if (v.node_type === "value") return get_raw_value(v as ValueNode);
				return null;
			})
			.filter((v): v is string => v !== null);
	}
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		const decl = status.scoped_declarations.find((d) => d.name === name);
		if (decl && decl.value) return resolve_array_values(decl.value, status);
	}
	if (node.node_type === "op") {
		const op = node as OperationNode;
		if (op.operator_func && op.type.is_array) {
			const left_vals = resolve_array_values(op.left_value, status);
			const right_vals = resolve_array_values(op.right_value, status);
			if (left_vals && op.op === "+") {
				const right_all = right_vals || [];
				return [...left_vals, ...right_all];
			}
			if (left_vals && op.op === "*" && op.right_value.node_type === "value") {
				const multiplier = parseInt((op.right_value as ValueNode).value);
				const result: string[] = [];
				for (let i = 0; i < multiplier; i++) result.push(...left_vals);
				return result;
			}
		}
	}
	return null;
}

function resolve_string_value(node: any, status: BuildStatus): string | null {
	if (node.node_type === "value") {
		const val = (node as ValueNode).value;
		if (val.startsWith('"') && val.endsWith('"')) return val;
		const decl = status.scoped_declarations.find((d) => d.name === val);
		if (decl && decl.value) return resolve_string_value(decl.value, status);
	}
	if (node.node_type === "op" && node.type?.name === "string") {
		return resolve_string_op(node, status);
	}
	return null;
}

function strip_quotes(s: string): string {
	return s.slice(1, -1);
}

function resolve_string_op(op: OperationNode, status: BuildStatus): string | null {
	const left = resolve_string_value(op.left_value, status);
	if (!left) return null;
	const left_content = strip_quotes(left);

	if (op.op === "+") {
		const right = resolve_string_value(op.right_value, status);
		if (!right) return null;
		const right_content = strip_quotes(right);
		return `"${left_content}${right_content}"`;
	}

	if (op.op === "*") {
		if (op.right_value.node_type === "value") {
			const multiplier = parseInt((op.right_value as ValueNode).value);
			if (isNaN(multiplier)) return null;
			return `"${left_content.repeat(multiplier)}"`;
		}
	}

	return null;
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
			const array_values = node.value as ArrayValuesNode;
			if (status.function_return_label && node.declaration === "var") {
				const element_size = size;
				const total_size = array_values.values.length * element_size;
				const offset = allocate_stack_space(status, total_size, element_size);
				status.stack_offsets!.set(node.name, offset);
				array_values.values.forEach((value, i) => {
					if (value.node_type === "value") {
						const raw = get_raw_value(value as ValueNode);
						status.code += `mov x0, #${raw}\n`;
						if (element_size === 1) {
							status.code += `strb w0, [x29, #${offset + i * element_size}]\n`;
						} else if (element_size === 4) {
							status.code += `str w0, [x29, #${offset + i * element_size}]\n`;
						} else {
							status.code += `str x0, [x29, #${offset + i * element_size}]\n`;
						}
					}
				});
			} else if (status.function_return_label) {
				emit_data(status, `${node.name}: ${directive} `);
				array_values.values.forEach((value, i) => {
					if (i > 0) emit_data(status, ", ");
					if (value.node_type === "value") {
						emit_data(status, get_raw_value(value as ValueNode));
					} else {
						emit_data(status, "/* complex */");
					}
				});
				emit_data(status, `\n.p2align 2\n`);
			} else {
				status.code += `${node.name}: ${directive} `;
				build_array_values_node(array_values, status);
				status.code += `\n.p2align 2\n`;
			}
		} else if (node.value && node.value.node_type === "range") {
			if (status.function_return_label) {
				const range_str = evaluate_range_static(node.value as RangeNode);
				if (range_str !== null) {
					emit_data(status, `${node.name}: ${directive} ${range_str}\n.p2align 2\n`);
				} else {
					emit_data(status, `${node.name}: ${directive} `);
					build_range_node(node.value as RangeNode, status);
					emit_data(status, `\n.p2align 2\n`);
				}
			} else {
				status.code += `${node.name}: ${directive} `;
				build_range_node(node.value as RangeNode, status);
				status.code += `\n.p2align 2\n`;
			}
		} else if (node.value && node.value.node_type === "op") {
			const op = node.value as OperationNode;
			if (op.operator_func && op.type.is_array) {
				const values = resolve_array_values(op, status);
				if (values) {
					if (status.function_return_label && node.declaration === "var") {
						const total_size = values.length * size;
						const offset = allocate_stack_space(status, total_size, size);
						status.stack_offsets!.set(node.name, offset);
						values.forEach((val, i) => {
							status.code += `mov x0, #${val}\n`;
							if (size === 1) {
								status.code += `strb w0, [x29, #${offset + i * size}]\n`;
							} else if (size === 4) {
								status.code += `str w0, [x29, #${offset + i * size}]\n`;
							} else {
								status.code += `str x0, [x29, #${offset + i * size}]\n`;
							}
						});
					} else if (status.function_return_label) {
						emit_data(status, `${node.name}: ${directive} ${values.join(", ")}\n.p2align 2\n`);
					} else {
						status.code += `${node.name}: ${directive} ${values.join(", ")}\n.p2align 2\n`;
					}
				} else {
					build_node(node.value, status);
				}
			} else {
				build_node(node.value, status);
			}
		} else {
			const array_size = node.type.length
				? size * parseInt((node.type.length as ValueNode).value)
				: 0;
			if (status.function_return_label && node.declaration === "var") {
				const offset = allocate_stack_space(status, array_size, size);
				status.stack_offsets!.set(node.name, offset);
			} else if (status.function_return_label) {
				emit_data(status, `${node.name}: .space ${array_size}\n.p2align 2\n`);
			} else {
				status.code += `${node.name}: .space ${array_size}\n.p2align 2\n`;
			}
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
		if (node.value.node_type === "op" && (node.value as OperationNode).type?.name === "string") {
			const op = node.value as OperationNode;
			const str_result = resolve_string_op(op, status);
			if (str_result !== null) {
				if (status.function_return_label) {
					emit_data(status, `${node.name}: .asciz ${escape_asciz(str_result)}\n.p2align 2\n`);
				} else {
					status.code += `${node.name}: .asciz ${escape_asciz(str_result)}\n.p2align 2\n`;
				}
				status.string_literal_names!.add(node.name);
			} else {
				build_node(node.value, status);
			}
		} else if (node.value.node_type === "value") {
			const value_node = node.value as ValueNode;
			const raw = get_raw_value(value_node);
			const is_literal =
				/^(\+|-)?\d+(\.\d+)?$/.test(raw) ||
				raw.startsWith('"') ||
				raw === "true" ||
				raw === "false";
			const use_stack = status.function_return_label && (node.declaration === "var" || !is_literal);
			if (use_stack) {
				const offset = allocate_stack_space(status, size, size);
				status.stack_offsets!.set(node.name, offset);
				if (!is_literal) {
					build_node(node.value, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					if (size === 1) {
						status.code += `strb w0, [x29, #${offset}]\n`;
					} else if (size === 4) {
						status.code += `str w0, [x29, #${offset}]\n`;
					} else {
						status.code += `str x0, [x29, #${offset}]\n`;
					}
				} else if (node.type.name === "float") {
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
				if (node.type.name === "string" && raw.startsWith('"')) {
					emit_data(status, `${node.name}: .asciz ${escape_asciz(raw)}\n.p2align 2\n`);
					status.string_literal_names!.add(node.name);
				} else {
					emit_data(status, `${node.name}: ${directive} ${raw}\n`);
					if (size % 4 !== 0) {
						emit_data(status, `.p2align 2\n`);
					}
				}
			}
		} else if (node.value.node_type === "array") {
			const array_values = node.value as ArrayValuesNode;
			if (status.function_return_label) {
				emit_data(status, `${node.name}: ${directive} `);
				array_values.values.forEach((value, i) => {
					if (i > 0) emit_data(status, ", ");
					if (value.node_type === "value") {
						emit_data(status, get_raw_value(value as ValueNode));
					} else {
						emit_data(status, "/* complex */");
					}
				});
				emit_data(status, `\n.p2align 2\n`);
			} else {
				status.code += `${node.name}: ${directive} `;
				build_array_values_node(array_values, status);
				status.code += `\n.p2align 2\n`;
			}
		} else if (node.value.node_type === "range") {
			if (status.function_return_label) {
				const range_str = evaluate_range_static(node.value as RangeNode);
				if (range_str !== null) {
					emit_data(status, `${node.name}: ${directive} ${range_str}\n.p2align 2\n`);
				} else {
					emit_data(status, `${node.name}: ${directive} `);
					build_range_node(node.value as RangeNode, status);
					emit_data(status, `\n.p2align 2\n`);
				}
			} else {
				status.code += `${node.name}: ${directive} `;
				build_range_node(node.value as RangeNode, status);
				status.code += `\n.p2align 2\n`;
			}
		} else if (node.value.node_type === "if" || node.value.node_type === "switch") {
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
		const total_size =
			node.type.is_array && node.type.length
				? size * parseInt((node.type.length as ValueNode).value)
				: size;
		const use_stack = status.function_return_label;
		if (use_stack) {
			const offset = allocate_stack_space(status, total_size, size);
			status.stack_offsets!.set(node.name, offset);
		} else {
			emit_data(status, `${node.name}: .space ${total_size}\n`);
			if (total_size % 4 !== 0) {
				emit_data(status, `.p2align 2\n`);
			}
		}
	}
}

function evaluate_range_static(node: RangeNode): string | null {
	const start = evaluate_range_const(node.left_value);
	const end = evaluate_range_const(node.right_value);
	if (start !== undefined && end !== undefined) {
		const actual_end = end + (node.inclusive ? 1 : 0);
		return [...Array(actual_end - start).keys()].map((v) => start + v).join(", ");
	}
	return null;
}

function evaluate_range_const(node: any): number | undefined {
	if (node.node_type === "value") {
		const n = parseInt(node.value);
		if (!isNaN(n)) return n;
	}
	if (node.node_type === "grouped") {
		return evaluate_range_const(node.value);
	}
	if (node.node_type === "op") {
		const left = evaluate_range_const(node.left_value);
		const right = evaluate_range_const(node.right_value);
		if (left !== undefined && right !== undefined) {
			switch (node.op) {
				case "+":
					return left + right;
				case "-":
					return left - right;
				case "*":
					return left * right;
				case "/":
					return Math.floor(left / right);
			}
		}
	}
	return undefined;
}
