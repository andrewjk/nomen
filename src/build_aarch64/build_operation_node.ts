import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import BaseNode from "../nodes/BaseNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import { emit_free } from "./utils/audit.ts";
import { allocate_stack_space, emit_var_address } from "./utils/stack_var.ts";
import { get_struct_size } from "./utils/struct_layout.ts";

let string_counter = 0;

export function reset_string_counter() {
	string_counter = 0;
}

function is_comparison(op: string): boolean {
	return [">", "<", "==", "!=", ">=", "<="].includes(op);
}

function map_cmp(op: string, unsigned: boolean = false): string {
	if (unsigned) {
		switch (op) {
			case ">":
				return "hi";
			case "<":
				return "lo";
			case "==":
				return "eq";
			case "!=":
				return "ne";
			case ">=":
				return "hs";
			case "<=":
				return "ls";
			default:
				return "eq";
		}
	}
	switch (op) {
		case ">":
			return "gt";
		case "<":
			return "lt";
		case "==":
			return "eq";
		case "!=":
			return "ne";
		case ">=":
			return "ge";
		case "<=":
			return "le";
		default:
			return "eq";
	}
}

function map_op(op: string, unsigned: boolean = false): string {
	switch (op) {
		case "+":
			return "add";
		case "-":
			return "sub";
		case "*":
			return "mul";
		case "/":
			return unsigned ? "udiv" : "sdiv";
		case "%":
			return "mod";
		case "<<":
			return "lsl";
		case ">>":
			return unsigned ? "lsr" : "asr";
		case "&":
			return "and";
		case "|":
			return "orr";
		case "^":
			return "eor";
		default:
			return "add";
	}
}

function emit_immediate(target_reg: string, value: string, status: BuildStatus) {
	const num = parseInt(value, 10);
	if (!isNaN(num) && num >= 0 && num <= 65535) {
		status.code += `mov ${target_reg}, #${value}`;
	} else {
		status.code += `ldr ${target_reg}, =${value}`;
	}
}

function build_operand(node: BaseNode, target_reg: string, status: BuildStatus) {
	if (node.node_type === "value") {
		const value = (node as ValueNode).value.replace("self", "_self");
		if (value === "true" || value === "false") {
			emit_immediate(target_reg, value === "true" ? "1" : "0", status);
			return;
		}
		if (/^(\+|-)*\d+$/.test(value) || /^(\+|-)*\d+.\d+$/.test(value)) {
			emit_immediate(target_reg, value, status);
			return;
		}
		const paramReg = status.function_param_regs?.get(value);
		if (paramReg) {
			if (status.function_param_vars?.has(value) || status.function_ref_params?.has(value)) {
				const param_type_name = (node as ValueNode).type?.name;
				const is_class =
					param_type_name && status.structs.find((s) => s.name === param_type_name && s.is_class);
				if (is_class) {
					if (paramReg !== target_reg) {
						status.code += `mov ${target_reg}, ${paramReg}`;
					}
				} else {
					status.code += `ldr ${target_reg}, [${paramReg}]`;
				}
			} else if (paramReg !== target_reg) {
				status.code += `mov ${target_reg}, ${paramReg}`;
			}
			return;
		}
		if (value.startsWith("'") && value.endsWith("'") && value.length === 3) {
			const char_code = value.charCodeAt(1);
			if (char_code <= 65535) {
				status.code += `mov ${target_reg}, #${char_code}`;
			} else {
				status.code += `ldr ${target_reg}, =${char_code}`;
			}
			return;
		}
		if (value.startsWith('"')) {
			const label = `_str_op_${string_counter++}`;
			status.strings!.set(label, value);
			status.code += `adr ${target_reg}, ${label}`;
			return;
		}
	}
	build_node(node, status);
	if (target_reg !== "x0") {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `mov ${target_reg}, x0\n`;
	}
}

function is_simple(node: BaseNode): boolean {
	return node.node_type === "value";
}

function is_float_type(node: BaseNode): boolean {
	const type = type_from_value_node(node);
	const name = type?.name || "";
	return name === "float" || name === "float32" || name === "float64" || name === "ufloat";
}

function is_unsigned_type(node: BaseNode): boolean {
	const type = type_from_value_node(node);
	const name = type?.name || "";
	return name === "uint64" || name === "uint32" || name === "uint8";
}

function build_float_operand(node: BaseNode, target_reg: string, status: BuildStatus) {
	if (node.node_type === "value") {
		const value = (node as ValueNode).value.replace("self", "_self");
		if (/^(\+|-)*\d+.\d+$/.test(value)) {
			const label = `_float_op_${string_counter++}`;
			const data = `${label}: .double ${value}\n.p2align 2\n`;
			if (status.function_return_label) {
				if (!status.function_data) status.function_data = "";
				status.function_data += data;
			} else {
				status.code += data;
			}
			status.code += `adr x3, ${label}\n`;
			status.code += `ldr ${target_reg}, [x3]\n`;
			return;
		}
		if (/^(\+|-)*\d+$/.test(value)) {
			status.code += `ldr x3, =${to_decimal_literal(value)}\n`;
			status.code += `scvtf ${target_reg}, x3\n`;
			return;
		}
		const alloc_reg_op = status.register_allocations?.get(value);
		if (alloc_reg_op) {
			status.code += `fmov ${target_reg}, ${alloc_reg_op}\n`;
			return;
		}
		const offset = status.stack_offsets?.get(value);
		if (offset !== undefined) {
			status.code += `ldr ${target_reg}, [x29, #${offset}]\n`;
			return;
		}
	}
	build_node(node, status);
	if (!status.code.endsWith("\n")) status.code += "\n";
	status.code += `fmov ${target_reg}, x0\n`;
}

function to_decimal_literal(value: string): string {
	if (value.startsWith("0x") || value.startsWith("0X"))
		return String(parseInt(value.replace(/_/g, ""), 16));
	if (value.startsWith("0o") || value.startsWith("0O"))
		return String(parseInt(value.replace(/_/g, ""), 8));
	if (value.startsWith("0b") || value.startsWith("0B"))
		return String(parseInt(value.replace(/_/g, ""), 2));
	return value;
}

function map_float_op(op: string): string {
	switch (op) {
		case "+":
			return "fadd";
		case "-":
			return "fsub";
		case "*":
			return "fmul";
		case "/":
			return "fdiv";
		default:
			return "fmul";
	}
}

function is_struct_type(node: BaseNode, status: BuildStatus): boolean {
	const type = type_from_value_node(node as ValueNode);
	return !!status.structs.find((s) => s.name === type.name && !s.is_simple_type);
}

function build_operator_operand(node: BaseNode, target_reg: string, status: BuildStatus) {
	if (node.node_type === "value" && is_struct_type(node, status)) {
		const name = (node as ValueNode).value;
		emit_var_address(status, target_reg, name);
		return;
	}
	build_operand(node, target_reg, status);
}

export default function build_operation_node(node: OperationNode, status: BuildStatus) {
	if (node.op === "!") {
		build_node(node.right_value, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `cmp x0, #0\n`;
		status.code += `cset x0, eq\n`;
		return;
	}

	if (node.operator_func) {
		const return_struct = status.structs.find(
			(s) => s.name === node.type?.name && !s.is_simple_type,
		);
		let return_temp_offset: number | undefined;
		if (return_struct) {
			return_temp_offset = allocate_stack_space(status, get_struct_size(node.type!.name, status));
			status.code += `add x8, x29, #${return_temp_offset}\n`;
		}

		// Check if operands are owned heap temps before building them
		const right_is_heap = node.type?.name === "string" && is_owned_heap_temp(node.right_value);
		const left_is_heap = node.type?.name === "string" && is_owned_heap_temp(node.left_value);

		// Evaluate right operand, spill to stack (left evaluation may clobber x1)
		const right_spill = allocate_stack_space(status, 8);
		build_operator_operand(node.right_value, "x0", status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `str x0, [x29, #${right_spill}]\n`;

		// Always spill left operand — nested ops (e.g. s * n) return in x0
		// which we must preserve through the spill/restore sequence.
		const left_spill = allocate_stack_space(status, 8);
		build_operator_operand(node.left_value, "x0", status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `str x0, [x29, #${left_spill}]\n`;

		// Restore right operand into x1
		status.code += `ldr x1, [x29, #${right_spill}]\n`;

		const label =
			node.operator_func.mangled_name ||
			`${node.operator_func.struct_name}_${node.operator_func.func_name}`;
		status.code += `bl ${label}\n`;

		// Save result before freeing heap temps (emit_free clobbers x0).
		const has_heap_temps = left_is_heap || right_is_heap;
		let result_spill: number | undefined;
		if (has_heap_temps) {
			result_spill = allocate_stack_space(status, 8);
			status.code += `str x0, [x29, #${result_spill}]\n`;
		}

		if (return_struct && return_temp_offset !== undefined) {
			status.code += `add x0, x29, #${return_temp_offset}\n`;
		}

		// Free owned heap temp operands AFTER the operator has consumed them.
		if (left_is_heap) {
			status.code += `ldr x0, [x29, #${left_spill}]\n`;
			emit_free(status);
		}
		if (right_is_heap) {
			status.code += `ldr x0, [x29, #${right_spill}]\n`;
			emit_free(status);
		}

		// Restore result if it was spilled.
		if (result_spill !== undefined) {
			status.code += `ldr x0, [x29, #${result_spill}]\n`;
		}

		// Operator functions that return strings produce heap-allocated results.
		if (node.type?.name === "string") {
			status.last_result_is_heap = true;
		}
		return;
	}

	const is_float =
		is_float_type(node) || is_float_type(node.left_value) || is_float_type(node.right_value);

	if (is_float && !is_comparison(node.op)) {
		const need_float_spill = !is_simple(node.left_value);
		build_float_operand(node.right_value, "d1", status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		if (need_float_spill) {
			status.code += `str d1, [sp, #-16]!\n`;
		}
		build_float_operand(node.left_value, "d0", status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		if (need_float_spill) {
			status.code += `ldr d1, [sp], #16\n`;
		}
		status.code += `${map_float_op(node.op)} d0, d0, d1\n`;
		status.code += `fmov x0, d0\n`;
		return;
	}

	const need_spill = !is_simple(node.left_value);

	build_operand(node.right_value, "x2", status);
	if (need_spill) {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `str x2, [sp, #-16]!\n`;
	} else {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	build_operand(node.left_value, "x1", status);
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
	if (need_spill) {
		status.code += `ldr x2, [sp], #16\n`;
	}

	const unsigned = is_unsigned_type(node.left_value) || is_unsigned_type(node.right_value);

	if (node.op === "&&") {
		status.code += `cmp x1, #0\n`;
		status.code += `cset x1, ne\n`;
		status.code += `cmp x2, #0\n`;
		status.code += `cset x2, ne\n`;
		status.code += `and x0, x1, x2\n`;
	} else if (node.op === "||") {
		status.code += `cmp x1, #0\n`;
		status.code += `cset x1, ne\n`;
		status.code += `cmp x2, #0\n`;
		status.code += `cset x2, ne\n`;
		status.code += `orr x0, x1, x2\n`;
	} else if (node.op === "??") {
		status.code += `cmp x1, #0\n`;
		status.code += `csel x0, x2, x1, eq\n`;
	} else if (is_comparison(node.op)) {
		status.code += `cmp x1, x2\n`;
		status.code += `cset x0, ${map_cmp(node.op, unsigned)}\n`;
	} else {
		const op = map_op(node.op, unsigned);
		if (op === "mod") {
			const div_op = unsigned ? "udiv" : "sdiv";
			status.code += `${div_op} x3, x1, x2\n`;
			status.code += `msub x0, x3, x2, x1\n`;
		} else {
			status.code += `${op} x0, x1, x2\n`;
		}
	}
}

// Whether an operand node produces a fresh heap string that is safe to free
// once consumed (nested concat/repeat, interpolation, or a *_to_string call).
// Variables, literals, and arbitrary function calls are NOT freed here because
// they may be static or owned elsewhere.
function is_owned_heap_temp(node: BaseNode): boolean {
	const type_name = (node as { type?: { name?: string } }).type?.name;
	if (type_name !== "string") return false;
	if (node.node_type === "op") return true;
	if (node.node_type === "func_call") {
		const name = (node as unknown as { name: string }).name;
		return (
			name.startsWith("_string_interpolate_") ||
			(name.endsWith("_to_string") && name !== "string_to_string")
		);
	}
	return false;
}
