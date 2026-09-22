import type BuildStatus from "../build_c/BuildStatus.ts";
import decode_char_literal from "../build_common/decode_char_literal.ts";
import emission_label from "../build_common/emission_label.ts";
import string_literal_length from "../build_common/string_literal_length.ts";
import { is_signed_int_type, is_signed_type } from "../built_in_types.ts";
import { is_int_literal, to_decimal_string } from "../int_literal.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_descriptor_address, materialize_func_value_a64 } from "./utils/closure_a64.ts";
import { emit_asm } from "./utils/code_buffer.ts";
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
		emit_asm(status, `adr ${reg}, ${label}\n`);
		emit_asm(status, `ldr ${reg}, [${reg}]`);
		return;
	}
	const num = parseInt(value, 10);
	if (!isNaN(num) && can_encode_as_mov(value)) {
		if (num >= 0 && num <= 65535) {
			emit_asm(status, `mov ${reg}, #${value}`);
		} else if (num < 0 && num >= -65536) {
			emit_asm(status, `movn ${reg}, #${-num - 1}`);
		} else {
			emit_asm(status, `ldr ${reg}, =${value}`);
		}
	} else {
		emit_asm(status, `ldr ${reg}, =${value}`);
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
	// The `self` keyword reads the `_self` local — but ONLY the bare keyword:
	// a substring rewrite corrupts string literals and identifiers that
	// merely contain "self" (`"myself"`, a variable named `selfish`).
	let value = node.value === "self" ? "_self" : node.value;

	// Full-unroll index substitution (ASM_PLAN_2 tranche E): inside an
	// unrolled copy, reads of the induction become immediate loads — the
	// copy's value is a compile-time constant.
	const const_idx = status.induction_const?.get(original_value);
	if (const_idx !== undefined) {
		emit_asm(status, `mov x0, #${const_idx}\n`);
		return;
	}

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
					emit_asm(status, `mov x9, #${case_index}\n`);
					emit_asm(status, `str x9, [x29, #${temp_offset}]\n`);
					for (let off = 8; off < enum_size; off += 8) {
						emit_asm(status, `str xzr, [x29, #${temp_offset + off}]\n`);
					}
					emit_asm(status, `add x0, x29, #${temp_offset}\n`);
				} else {
					emit_asm(status, `mov x0, #${case_index}\n`);
				}
				return;
			}
		}
		const bitset_node = status.bitsets.find((b) => value.startsWith(b.name + "_"));
		if (bitset_node) {
			const case_name = value.substring(bitset_node.name.length + 1);
			const case_index = bitset_node.cases.indexOf(case_name);
			if (case_index >= 0) {
				// Evaluated constant — see the access path above.
				emit_asm(status, `mov x0, #${2 ** case_index}\n`);
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
		emit_asm(status, `mov x0, x19\n`);
		emit_asm(status, `mov x1, x20\n`);
		return;
	}

	if (paramReg) {
		if (original_value === "self" || value === "_self") {
			// self is always the struct address, don't dereference
			if (paramReg !== "x0") {
				emit_asm(status, `mov x0, ${paramReg}`);
			}
		} else if (node.type?.is_pointer) {
			// A `ptr T` param is a bare machine word in its register.
			if (paramReg !== "x0") {
				emit_asm(status, `mov x0, ${paramReg}`);
			}
		} else if (
			status.function_param_vars?.has(original_value) ||
			status.function_param_vars?.has(value) ||
			status.function_ref_params?.has(original_value) ||
			status.function_ref_params?.has(value)
		) {
			const param_type_name = node.type?.name;
			// A trait-typed value is a POINTER (vtable-bearing instance), like
			// a class — the register holds the value itself; only non-class/
			// non-trait var/ref params ride the pointer-to-storage deref.
			const is_class =
				(param_type_name && status.structs.find((s) => s.name === param_type_name && s.is_class)) ||
				(!!param_type_name && !!status.traits.find((t) => t.name === param_type_name)) ||
				!!status.class_vars?.has(value) ||
				!!status.class_vars?.has(original_value);
			if (is_class) {
				if (paramReg !== "x0") {
					emit_asm(status, `mov x0, ${paramReg}`);
				}
			} else {
				emit_asm(status, deref_load_instr(paramReg, param_type_name));
			}
		} else {
			// const param - value in register
			if (paramReg !== "x0") {
				emit_asm(status, `mov x0, ${paramReg}`);
			}
			// if already x0, no-op
		}
		return;
	}

	if (is_literal(value)) {
		emit_immediate("x0", to_decimal_string(value), status);
		return;
	}

	if (value.startsWith("'") && value.endsWith("'")) {
		// The tokenizer leaves escape pairs raw (`'\\'`, `'\n'`, `'\xNN'`);
		// decode them here the same way the C backend does.
		const char_code = decode_char_literal(value);
		if (char_code !== undefined) {
			if (char_code <= 65535) {
				emit_asm(status, `mov x0, #${char_code}`);
			} else {
				emit_asm(status, `ldr x0, =${char_code}`);
			}
			return;
		}
	}

	if (value.startsWith('"')) {
		const label = `_str_${string_counter++}`;
		status.strings!.set(label, value);
		// Fat string: the literal is the (ptr, len) pair — the length is the
		// unescaped byte count, computed at compile time (no strlen).
		emit_asm(status, `adr x0, ${label}\n`);
		emit_asm(status, `mov x1, #${string_literal_length(value)}\n`);
		return;
	}

	// A captured outer name inside a capturing lambda (CLOSURE.md Phase 2):
	// load the env pointer from its frame slot and the capture's field from
	// the env. The checker records a capture only when the reference resolves
	// to the outer value, so a nearer param/local can't be shadowed — guard
	// anyway.
	if (status.closure_env_offsets?.has(value) && !status.function_param_regs?.has(value)) {
		const off = status.closure_env_offsets.get(value)!;
		emit_asm(status, `ldr x9, [x29, #${status.closure_env_slot}]\n`);
		const cap_struct = status.structs.find((s) => s.name === node.type?.name && !s.is_simple_type);
		if (cap_struct && !cap_struct.is_class) {
			// A captured value struct is read by ADDRESS (its env field is the
			// struct's bytes), matching how local struct values are used.
			emit_asm(status, `add x0, x9, #${off}\n`);
		} else {
			emit_asm(status, `ldr x0, [x9, #${off}]\n`);
			// A captured string is a fat (ptr, len) pair in the env — load the
			// len half too.
			if (node.type?.name === "string" && !node.type.is_view && !node.type.is_array) {
				emit_asm(status, `ldr x1, [x9, #${off + 8}]\n`);
			}
		}
		return;
	}

	// Function reference - need the address. A nested function emits under
	// its uniquified label (stamped via resolved_function at check time).
	if (node.type?.name === "func") {
		const func_offset = status.stack_offsets?.get(value);
		if (func_offset !== undefined) {
			// The slot holds a closure descriptor (CLOSURE.md).
			emit_asm(status, `ldr x0, [x29, #${func_offset}]\n`);
		} else if (node.resolved_function) {
			// A named function as a VALUE materializes its closure
			// descriptor — a bare code address can't carry the env.
			const desc = materialize_func_value_a64(node.resolved_function, status);
			emit_descriptor_address(status, "x0", desc);
		} else {
			emit_asm(status, `adr x0, ${emission_label(node.resolved_function ?? { name: value })}\n`);
		}
		return;
	}

	// Variable reference - check register allocation first, then stack offset
	const alloc_reg = status.register_allocations?.get(value);
	if (alloc_reg) {
		if (node.type?.is_pointer) {
			// A `ptr T` local promoted to a register holds the address itself.
			if (alloc_reg !== "x0") {
				emit_asm(status, `mov x0, ${alloc_reg}\n`);
			}
			return;
		}
		if (status.function_ref_params?.has(value) || status.function_ref_params?.has(original_value)) {
			if (alloc_reg !== "x0") {
				emit_asm(status, `mov x0, ${alloc_reg}\n`);
			}
			const param_type_name = node.type?.name;
			// Trait-typed values are pointers like classes — no deref (see the
			// paramReg branch above).
			const is_class =
				(param_type_name && status.structs.find((s) => s.name === param_type_name && s.is_class)) ||
				(!!param_type_name && !!status.traits.find((t) => t.name === param_type_name)) ||
				!!status.class_vars?.has(value) ||
				!!status.class_vars?.has(original_value);
			if (!is_class) {
				emit_asm(status, deref_load_instr("x0", param_type_name));
			}
		} else {
			if (alloc_reg !== "x0") {
				if (alloc_reg.startsWith("d")) {
					emit_asm(status, `fmov x0, ${alloc_reg}`);
				} else {
					emit_asm(status, `mov x0, ${alloc_reg}`);
				}
			}
		}
		return;
	}
	let offset = status.stack_offsets?.get(value);
	if (offset === undefined && value !== original_value) {
		offset = status.stack_offsets?.get(original_value);
	}
	if (offset !== undefined) {
		const type_name = node.type?.name || "";
		const is_array = node.type?.is_array || false;
		if (node.type?.is_pointer) {
			// A `ptr T` local is a single 8-byte word: the address itself.
			emit_asm(status, `ldr x0, [x29, #${offset}]`);
			return;
		}
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
				emit_asm(status, `ldr x0, [x29, #${offset}]`);
			} else {
				emit_asm(status, `add x0, x29, #${offset}`);
			}
		} else if (status.enums.find((e) => e.name === type_name && e.has_associated_data)) {
			// An enum-with-data local is a multi-word (tag + payload) blob —
			// a value reference (return, assignment RHS, argument) passes its
			// ADDRESS so consumers struct-copy the full value. The generic
			// scalar path below would load only the 8-byte tag word.
			emit_asm(status, `add x0, x29, #${offset}`);
		} else if (
			type_name === "string" &&
			!is_ref &&
			(value === "_self" || original_value === "self") &&
			status.current_struct?.name === "string" &&
			!status.function_param_regs?.has("self")
		) {
			// `ref self` on the string struct: the slot holds the RAW incoming
			// &receiver (one word — never the pair the by-value convention
			// spills), so the fat value is rebuilt by dereferencing it.
			emit_asm(status, `ldr x9, [x29, #${offset}]\n`);
			emit_asm(status, `ldr x0, [x9]\n`);
			emit_asm(status, `ldr x1, [x9, #8]\n`);
		} else if (type_name === "string" && !is_ref) {
			// Fat string slot: load the (ptr, len) pair.
			emit_string_pair_load(status, value);
		} else if (is_ref && !is_class) {
			// The slot holds an 8-byte pointer to the caller's storage. Load
			// the pointer, then dereference with the pointed-to value's width
			// (e.g. `ldrb` for `ref bool`) — NOT the 8-byte `ldr` used before.
			emit_asm(status, `ldr x0, [x29, #${offset}]\n`);
			emit_asm(status, deref_load_instr("x0", type_name));
		} else {
			const size = aarch64_size(type_name);
			const signed = is_signed_type(type_name);
			if (size === 1) {
				emit_asm(status, signed ? `ldrsb x0, [x29, #${offset}]` : `ldrb w0, [x29, #${offset}]`);
			} else if (size === 2) {
				emit_asm(status, signed ? `ldrsh x0, [x29, #${offset}]` : `ldrh w0, [x29, #${offset}]`);
			} else if (size === 4) {
				emit_asm(status, signed ? `ldrsw x0, [x29, #${offset}]` : `ldr w0, [x29, #${offset}]`);
			} else {
				emit_asm(status, `ldr x0, [x29, #${offset}]`);
			}
		}
	} else {
		const type_name = node.type?.name || "";
		const is_array = node.type?.is_array || false;
		if (is_array) {
			emit_asm(status, `adr x0, ${value}`);
		} else if (type_name === "string" && status.string_literal_names?.has(value)) {
			// A named folded-const string literal: the label's byte length was
			// recorded when the data was emitted (string_literal_lengths).
			const len = status.string_literal_lengths?.get(value) ?? 0;
			emit_asm(status, `adr x0, ${value}\n`);
			emit_asm(status, `mov x1, #${len}\n`);
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
				emit_asm(status, `adr x0, ${value}\nldrb w0, [x0]`);
			} else if (size === 2) {
				emit_asm(status, `adr x0, ${value}\nldrh w0, [x0]`);
			} else {
				emit_asm(status, `adr x0, ${value}\nldr x0, [x0]`);
			}
		}
	}
}
