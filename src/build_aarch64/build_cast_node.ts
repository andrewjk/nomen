import type BuildStatus from "../build/BuildStatus.ts";
import type_from_value_node from "../build/utils/type_from_value_node.ts";
import CastNode from "../nodes/CastNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { allocate_stack_space, emit_var_address } from "./utils/stack_var.ts";
import { get_struct_size } from "./utils/struct_layout.ts";

let cast_temp_counter = 0;

export function reset_cast_temp_counter() {
	cast_temp_counter = 0;
}

function ensure_newline(status: BuildStatus) {
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
}

export default function build_cast_node(node: CastNode, status: BuildStatus) {
	if (node.operator_func) {
		build_struct_cast(node, status);
		return;
	}

	build_node(node.value, status);
	ensure_newline(status);

	const from_type = type_from_value_node(node.value);
	const from = from_type.name;
	const to = node.target_type.name;
	const fs = aarch64_size(from);
	const ts = aarch64_size(to);

	if (from === to || (fs === ts && from !== "float" && from !== "float32" && from !== "float64")) {
		return;
	}

	if (ts > fs) {
		if (from === "bool" || from === "int8" || from === "uint8" || from === "char") {
			if (from === "int8" || from === "char") {
				status.code += `sxtb x0, x0\n`;
			} else {
				status.code += `and x0, x0, #0xFF\n`;
			}
		} else if (from === "int16") {
			status.code += `sxth x0, x0\n`;
		} else if (from === "uint16") {
			status.code += `and x0, x0, #0xFFFF\n`;
		} else if (from === "int32" || from === "int") {
			status.code += `sxtw x0, x0\n`;
		} else if (from === "uint32" || from === "uint") {
			status.code += `and x0, x0, #0xFFFFFFFF\n`;
		}
	} else if (ts < fs) {
		if (to === "bool" || to === "int8" || to === "uint8" || to === "char") {
			status.code += `and x0, x0, #0xFF\n`;
		} else if (to === "int16" || to === "uint16") {
			status.code += `and x0, x0, #0xFFFF\n`;
		} else if (to === "int32" || to === "uint32") {
			status.code += `and x0, x0, #0xFFFFFFFF\n`;
		}
	}
}

function build_struct_cast(node: CastNode, status: BuildStatus) {
	const target_struct = status.structs.find(
		(s) => s.name === node.target_type.name && !s.is_simple_type,
	);

	let temp_label = "";
	if (target_struct) {
		const struct_size = get_struct_size(node.target_type.name, status);
		const offset = allocate_stack_space(status, struct_size);
		temp_label = `_cast_temp_${cast_temp_counter++}`;
		status.stack_offsets!.set(temp_label, offset);
		status.code += `add x8, x29, #${offset}\n`;
	}

	if (node.value.node_type === "value") {
		const name = (node.value as any).value;
		const paramReg = status.function_param_regs?.get(name);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node.value, status);
		ensure_newline(status);
	}

	status.code += `bl ${node.operator_func!.struct_name}_as\n`;

	if (target_struct && temp_label) {
		const offset = status.stack_offsets!.get(temp_label)!;
		status.code += `add x0, x29, #${offset}\n`;
	}
}
