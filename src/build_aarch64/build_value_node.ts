import type BuildStatus from "../build_c/BuildStatus.ts";
import emission_label from "../build_common/emission_label.ts";
import string_literal_length from "../build_common/string_literal_length.ts";
import { is_signed_int_type, is_signed_type } from "../built_in_types.ts";
import { is_int_literal, to_decimal_string } from "../int_literal.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { find_enum_for_case } from "./utils/enum_case.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";
import { emit_string_pair_load } from "./utils/string_pair.ts";
import { get_enum_size } from "./utils/struct_layout.ts";

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
		is_int_literal(value) ||
		/^(\+|-)*\d+.\d+([eE](\+|-)?\d+)?$/.test(value) ||
		value === "true" ||
		value === "false"
	);
}

// Load instruction that dereferences a pointer (in `reg`) to a value of
// `type_name`, placing the sign/zero-extended result in x0. Used for `ref T`
// params: the param slot/register holds an 8-byte pointer, and the pointed-to
// value must be read with T's width (e.g. `ldrb` for `ref bool`).
function deref_load_instr(reg: string, type_name: string): string {
	const size = aarch64_size(type_name);
	const signed = is_signed_int_type(type_name);
	if (size === 1) return signed ? `ldrsb x0, [${reg}]` : `ldrb w0, [${reg}]`;
	if (size === 2) return signed ? `ldrsh x0, [${reg}]` : `ldrh w0, [${reg}]`;
	if (size === 4) return signed ? `ldrsw x0, [${reg}]` : `ldr w0, [${reg}]`;
	return `ldr x0, [${reg}]`;
}

export default function build_value_node(node: ValueNode, status: BuildStatus) {
	const original_value = node.value;
	let value = node.value.replace("self", "_self");

	// A top-level non-primitive `const` (e.g. geometry-type constants like
	// `DEFAULT_PARAMS`) is inlined at every use site rather than emitted as a
	// module-scope global — the initializer is typically a struct constructor
	// call, which would emit bare instructions at module scope that never run.
	// Build the const's initializer in place; named-field overrides are
	// applied by the caller via `emit_field_overrides`.
	const inlined = status.top_level_consts?.get(original_value);
	if (inlined?.value) {
		build_node(inlined.value, status);
		return;
	}

	if (node.is_enum_shorthand) {
		const found = find_enum_for_case(value, status);
		if (found) {
			const enum_node = found.enum_node;
			const case_name = found.case_name;
			const case_index = enum_node.cases.findIndex((c) => c.name === case_name);
			if (case_index >= 0) {
				// For an enum with associated data, even a no-arg case must
				// produce a multi-word temp (tag at +0, zeroed payload) so the
				// caller can struct-copy the full value. A simple enum emits
				// the tag immediate directly.
				if (enum_node.has_associated_data) {
					const enum_size = get_enum_size(enum_node.name, status);
					const temp_offset = allocate_stack_space(status, enum_size);
					status.code += `mov x9, #${case_index}\n`;
					status.code += `str x9, [x29, #${temp_offset}]\n`;
					for (let off = 8; off < enum_size; off += 8) {
						status.code += `str xzr, [x29, #${temp_offset + off}]\n`;
					}
					status.code += `add x0, x29, #${temp_offset}\n`;
				} else {
					status.code += `mov x0, #${case_index}\n`;
				}
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

	// The `string` struct's by-value self rides as the (x19, x20) pair
	// (ptr, len) — see build_struct_node's string-self prologue.
	if (
		paramReg === "x19" &&
		(original_value === "self" || value === "_self") &&
		status.current_struct?.name === "string"
	) {
		status.code += `mov x0, x19\n`;
		status.code += `mov x1, x20\n`;
		return;
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
				(param_type_name && status.structs.find((s) => s.name === param_type_name && s.is_class)) ||
				!!status.class_vars?.has(value) ||
				!!status.class_vars?.has(original_value);
			if (is_class) {
				if (paramReg !== "x0") {
					status.code += `mov x0, ${paramReg}`;
				}
			} else {
				status.code += deref_load_instr(paramReg, param_type_name);
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
		emit_immediate("x0", to_decimal_string(value), status);
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
		// Fat string: the literal is the (ptr, len) pair — the length is the
		// unescaped byte count, computed at compile time (no strlen).
		status.code += `adr x0, ${label}\n`;
		status.code += `mov x1, #${string_literal_length(value)}\n`;
		return;
	}

	// Function reference - need the address. A nested function emits under
	// its uniquified label (stamped via resolved_function at check time).
	if (node.type?.name === "func") {
		const func_offset = status.stack_offsets?.get(value);
		if (func_offset !== undefined) {
			status.code += `ldr x0, [x29, #${func_offset}]\n`;
		} else {
			status.code += `adr x0, ${emission_label(node.resolved_function ?? { name: value })}\n`;
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
				(param_type_name && status.structs.find((s) => s.name === param_type_name && s.is_class)) ||
				!!status.class_vars?.has(value) ||
				!!status.class_vars?.has(original_value);
			if (!is_class) {
				status.code += deref_load_instr("x0", param_type_name);
			}
		} else {
			if (alloc_reg !== "x0") {
				if (alloc_reg.startsWith("d")) {
					status.code += `fmov x0, ${alloc_reg}`;
				} else {
					status.code += `mov x0, ${alloc_reg}`;
				}
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
			(param_type_name && status.structs.find((s) => s.name === param_type_name && s.is_class)) ||
			!!status.class_vars?.has(value) ||
			!!status.class_vars?.has(original_value);
		if (is_array) {
			// A heap-array variable (from `Array.with(...)`, a call result,
			// etc. — tracked in `heap_array_vars`) stores a POINTER to the
			// heap buffer in its slot. A value use (return, function arg,
			// assignment RHS) wants that pointer loaded, not the slot's
			// address. Stack arrays (literals / fixed-size) keep the
			// `add x0, x29, #offset` form: their slot IS the inline elements,
			// and by-reference passes (e.g. to an array param) want &slot.
			if (status.heap_array_vars?.has(value)) {
				status.code += `ldr x0, [x29, #${offset}]`;
			} else {
				status.code += `add x0, x29, #${offset}`;
			}
		} else if (status.enums.find((e) => e.name === type_name && e.has_associated_data)) {
			// An enum-with-data local is a multi-word (tag + payload) blob —
			// a value reference (return, assignment RHS, argument) passes its
			// ADDRESS so consumers struct-copy the full value. The generic
			// scalar path below would load only the 8-byte tag word.
			status.code += `add x0, x29, #${offset}`;
		} else if (type_name === "string" && !is_ref) {
			// Fat string slot: load the (ptr, len) pair.
			emit_string_pair_load(status, value);
		} else if (is_ref && !is_class) {
			// The slot holds an 8-byte pointer to the caller's storage. Load
			// the pointer, then dereference with the pointed-to value's width
			// (e.g. `ldrb` for `ref bool`) — NOT the 8-byte `ldr` used before.
			status.code += `ldr x0, [x29, #${offset}]\n`;
			status.code += deref_load_instr("x0", type_name);
		} else {
			const size = aarch64_size(type_name);
			const signed = is_signed_type(type_name);
			if (size === 1) {
				status.code += signed ? `ldrsb x0, [x29, #${offset}]` : `ldrb w0, [x29, #${offset}]`;
			} else if (size === 2) {
				status.code += signed ? `ldrsh x0, [x29, #${offset}]` : `ldrh w0, [x29, #${offset}]`;
			} else if (size === 4) {
				status.code += signed ? `ldrsw x0, [x29, #${offset}]` : `ldr w0, [x29, #${offset}]`;
			} else {
				status.code += `ldr x0, [x29, #${offset}]`;
			}
		}
	} else {
		const type_name = node.type?.name || "";
		const is_array = node.type?.is_array || false;
		if (is_array) {
			status.code += `adr x0, ${value}`;
		} else if (type_name === "string" && status.string_literal_names?.has(value)) {
			// A named folded-const string literal: the label's byte length was
			// recorded when the data was emitted (string_literal_lengths).
			const len = status.string_literal_lengths?.get(value) ?? 0;
			status.code += `adr x0, ${value}\n`;
			status.code += `mov x1, #${len}\n`;
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
