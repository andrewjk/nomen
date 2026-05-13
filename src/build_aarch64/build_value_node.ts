import type BuildStatus from "../build/BuildStatus.ts";
import ValueNode from "../nodes/ValueNode.ts";

let string_counter = 0;

export function reset_string_counter() {
	string_counter = 0;
}

function is_literal(value: string): boolean {
	return (
		/^(\+|-)*\d+$/.test(value) ||
		/^(\+|-)*\d+.\d+$/.test(value) ||
		value === "true" ||
		value === "false"
	);
}

export default function build_value_node(node: ValueNode, status: BuildStatus) {
	const original_value = node.value;
	let value = node.value.replace("self", "_self");

	if (value === "true") {
		value = "1";
	} else if (value === "false") {
		value = "0";
	}

	// Check param regs with both original and replaced name
	let paramReg = status.function_param_regs?.get(original_value);
	if (!paramReg) {
		paramReg = status.function_param_regs?.get(value);
	}

	if (paramReg) {
		if (original_value === "self" || value === "_self") {
			// self is always the struct address, don't dereference
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}`;
			}
		} else if (
			status.function_param_vars?.has(original_value) ||
			status.function_param_vars?.has(value)
		) {
			// var param - address in register, load value
			status.code += `ldr x0, [${paramReg}]`;
		} else {
			// const param - value in register
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}`;
			}
			// if already x0, no-op
		}
		return;
	}

	if (is_literal(value)) {
		status.code += `ldr x0, =${value}`;
		return;
	}

	if (value.startsWith("'") && value.endsWith("'") && value.length === 3) {
		const char_code = value.charCodeAt(1);
		status.code += `ldr x0, =${char_code}`;
		return;
	}

	if (value.startsWith('"')) {
		const label = `_str_${string_counter++}`;
		status.strings!.set(label, value);
		status.code += `adr x0, ${label}`;
		return;
	}

	// Function reference - just need the address
	if (node.type?.name === "func") {
		status.code += `adr x0, ${value}`;
		return;
	}

	// Variable reference - use stack offset if available
	const offset = status.stack_offsets?.get(value);
	if (offset !== undefined) {
		// Infer size from type if available, default to 8
		const type_name = node.type?.name || "";
		const size =
			type_name === "float"
				? 4
				: type_name === "uint8" || type_name === "int8" || type_name === "char"
					? 1
					: 8;
		const signed =
			type_name.startsWith("int") ||
			type_name === "float" ||
			type_name === "float32" ||
			type_name === "float64";
		if (size === 1) {
			status.code += signed ? `ldrsb x0, [x29, #${offset}]` : `ldrb w0, [x29, #${offset}]`;
		} else if (size === 4) {
			status.code += signed ? `ldrsw x0, [x29, #${offset}]` : `ldr w0, [x29, #${offset}]`;
		} else {
			status.code += `ldr x0, [x29, #${offset}]`;
		}
	} else {
		const type_name = node.type?.name || "";
		if (type_name === "string" && status.string_literal_names?.has(value)) {
			status.code += `adr x0, ${value}`;
		} else {
			status.code += `adr x0, ${value}\nldr x0, [x0]`;
		}
	}
}
