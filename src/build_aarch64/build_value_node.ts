import type BuildStatus from "../build_c/BuildStatus.ts";
import ValueNode from "../nodes/ValueNode.ts";

let string_counter = 0;

export function reset_string_counter() {
	string_counter = 0;
}

function can_encode_as_mov(value: string): boolean {
	if (value.startsWith("-")) return value.length <= 7;
	if (value.startsWith("+")) return value.length <= 6;
	return value.length <= 5;
}

function emit_immediate(reg: string, value: string, status: BuildStatus) {
	if (value.includes(".")) {
		const label = `_float_lit_${string_counter++}`;
		status.float_literals!.set(label, value);
		status.code += `adr ${reg}, ${label}\n`;
		status.code += `ldr ${reg}, [${reg}]`;
		return;
	}
	const num = parseInt(value, 10);
	if (!isNaN(num) && can_encode_as_mov(value)) {
		if (num >= 0 && num <= 65535) {
			status.code += `mov ${reg}, #${value}`;
		} else if (num < 0 && num >= -65536) {
			status.code += `movn ${reg}, #${-num - 1}`;
		} else {
			status.code += `ldr ${reg}, =${value}`;
		}
	} else {
		status.code += `ldr ${reg}, =${value}`;
	}
}

function is_literal(value: string): boolean {
	return (
		/^(\+|-)*\d+$/.test(value) ||
		/^(\+|-)*\d+.\d+([eE](\+|-)?\d+)?$/.test(value) ||
		/^0x[0-9a-fA-F_]+$/.test(value) ||
		/^0o[0-7_]+$/.test(value) ||
		/^0b[01_]+$/.test(value) ||
		value === "true" ||
		value === "false"
	);
}

function to_decimal(value: string): string {
	if (value.startsWith("0x") || value.startsWith("0X")) {
		return String(parseInt(value.replace(/_/g, ""), 16));
	}
	if (value.startsWith("0o") || value.startsWith("0O")) {
		return String(parseInt(value.replace(/_/g, ""), 8));
	}
	if (value.startsWith("0b") || value.startsWith("0B")) {
		return String(parseInt(value.replace(/_/g, ""), 2));
	}
	return value;
}

export default function build_value_node(node: ValueNode, status: BuildStatus) {
	const original_value = node.value;
	let value = node.value.replace("self", "_self");

	if (node.is_enum_shorthand) {
		const enum_node = status.enums.find((e) => value.startsWith(e.name + "_"));
		if (enum_node) {
			const case_name = value.substring(enum_node.name.length + 1);
			const case_index = enum_node.cases.findIndex((c) => c.name === case_name);
			if (case_index >= 0) {
				status.code += `mov x0, #${case_index}\n`;
				return;
			}
		}
		const bitset_node = status.bitsets.find((b) => value.startsWith(b.name + "_"));
		if (bitset_node) {
			const case_name = value.substring(bitset_node.name.length + 1);
			const case_index = bitset_node.cases.indexOf(case_name);
			if (case_index >= 0) {
				status.code += `mov x0, #(1 << ${case_index})\n`;
				return;
			}
		}
	}

	if (value === "true") {
		value = "1";
	} else if (value === "false") {
		value = "0";
	} else if (value === "null") {
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
			status.function_param_vars?.has(value) ||
			status.function_ref_params?.has(original_value) ||
			status.function_ref_params?.has(value)
		) {
			const param_type_name = node.type?.name;
			const is_class =
				param_type_name && status.structs.find((s) => s.name === param_type_name && s.is_class);
			if (is_class) {
				if (paramReg !== "x0") {
					status.code += `mov x0, ${paramReg}`;
				}
			} else {
				status.code += `ldr x0, [${paramReg}]`;
			}
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
		emit_immediate("x0", to_decimal(value), status);
		return;
	}

	if (value.startsWith("'") && value.endsWith("'") && value.length === 3) {
		const char_code = value.charCodeAt(1);
		if (char_code <= 65535) {
			status.code += `mov x0, #${char_code}`;
		} else {
			status.code += `ldr x0, =${char_code}`;
		}
		return;
	}

	if (value.startsWith('"')) {
		const label = `_str_${string_counter++}`;
		status.strings!.set(label, value);
		status.code += `adr x0, ${label}`;
		return;
	}

	// Function reference - need the address
	if (node.type?.name === "func") {
		const func_offset = status.stack_offsets?.get(value);
		if (func_offset !== undefined) {
			status.code += `ldr x0, [x29, #${func_offset}]\n`;
		} else {
			status.code += `adr x0, ${value}\n`;
		}
		return;
	}

	// Variable reference - check register allocation first, then stack offset
	const alloc_reg = status.register_allocations?.get(value);
	if (alloc_reg) {
		if (status.function_ref_params?.has(value) || status.function_ref_params?.has(original_value)) {
			if (alloc_reg !== "x0") {
				status.code += `mov x0, ${alloc_reg}\n`;
			}
			const param_type_name = node.type?.name;
			const is_class =
				param_type_name && status.structs.find((s) => s.name === param_type_name && s.is_class);
			if (!is_class) {
				status.code += `ldr x0, [x0]`;
			}
		} else {
			if (alloc_reg !== "x0") {
				status.code += `mov x0, ${alloc_reg}`;
			}
		}
		return;
	}
	const offset = status.stack_offsets?.get(value);
	if (offset !== undefined) {
		const type_name = node.type?.name || "";
		const is_array = node.type?.is_array || false;
		const is_ref =
			status.function_ref_params?.has(value) || status.function_ref_params?.has(original_value);
		const param_type_name = node.type?.name;
		const is_class =
			param_type_name && status.structs.find((s) => s.name === param_type_name && s.is_class);
		if (is_array) {
			status.code += `add x0, x29, #${offset}`;
		} else {
			const size =
				type_name === "uint8" ||
				type_name === "int8" ||
				type_name === "char" ||
				type_name === "bool"
					? 1
					: type_name === "int16" || type_name === "uint16"
						? 2
						: type_name === "int32" || type_name === "uint32"
							? 4
							: 8;
			const signed =
				type_name.startsWith("int") ||
				type_name === "float" ||
				type_name === "float32" ||
				type_name === "float64";
			if (size === 1) {
				status.code += signed ? `ldrsb x0, [x29, #${offset}]` : `ldrb w0, [x29, #${offset}]`;
			} else if (size === 2) {
				status.code += signed ? `ldrsh x0, [x29, #${offset}]` : `ldrh w0, [x29, #${offset}]`;
			} else if (size === 4) {
				status.code += signed ? `ldrsw x0, [x29, #${offset}]` : `ldr w0, [x29, #${offset}]`;
			} else {
				status.code += `ldr x0, [x29, #${offset}]`;
			}
			if (is_ref && !is_class) {
				status.code += `\nldr x0, [x0]`;
			}
		}
	} else {
		const type_name = node.type?.name || "";
		const is_array = node.type?.is_array || false;
		if (is_array) {
			status.code += `adr x0, ${value}`;
		} else if (type_name === "string" && status.string_literal_names?.has(value)) {
			status.code += `adr x0, ${value}`;
		} else {
			const size =
				type_name === "uint8" ||
				type_name === "int8" ||
				type_name === "char" ||
				type_name === "bool"
					? 1
					: type_name === "int16" || type_name === "uint16"
						? 2
						: 8;
			if (size === 1) {
				status.code += `adr x0, ${value}\nldrb w0, [x0]`;
			} else if (size === 2) {
				status.code += `adr x0, ${value}\nldrh w0, [x0]`;
			} else {
				status.code += `adr x0, ${value}\nldr x0, [x0]`;
			}
		}
	}
}
