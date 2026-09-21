import type BuildStatus from "../../build_c/BuildStatus.ts";
import type Type from "../../nodes/Type.ts";
import { emit_asm } from "./code_buffer.ts";
import { get_struct_size } from "./struct_layout.ts";

/**
 * Byte width of one element behind a `ptr T` — the same layout table the
 * raw asm `T_SIZE` substitution uses, so unsafe Nomen bodies stride slabs
 * exactly like the raw blocks they replaced.
 */
export function pointer_element_size(elem: Type, status: BuildStatus): number {
	const name = elem.name;
	if (name === "string") return 16;
	const struct = status.structs.find((s) => s.name === name && !s.is_simple_type);
	if (struct && !struct.is_class) return get_struct_size(name, status);
	// Scalars and classes are one machine word; sub-word scalars (int8/16/32,
	// bool, char) are handled by aarch64_size through their name.
	return aarch64_scalar_size(name);
}

function aarch64_scalar_size(name: string): number {
	switch (name) {
		case "bool":
		case "int8":
		case "uint8":
		case "char":
			return 1;
		case "int16":
		case "uint16":
			return 2;
		case "int32":
		case "uint32":
			return 4;
	}
	return 8;
}

/**
 * Emit `addr = ptr + index * size` into x9, where the pointer is in x0 and
 * the index in x1. Uses `madd` (never the shifted-`add` form) so every
 * emitted instruction is covered by the asm validator's MNEMONICS table.
 * Element sizes are powers of two for every instantiated element type, but
 * `madd` is correct regardless — raw blocks use the same shape.
 */
export function emit_index_address(size: number, status: BuildStatus) {
	if (size === 1) {
		emit_asm(status, `add x9, x0, x1\n`);
		return;
	}
	emit_asm(status, `mov x2, #${size}\n`);
	emit_asm(status, `madd x9, x1, x2, x0\n`);
}

/**
 * Emit a width-matched LOAD of the element at x9:
 * - sub-word/word scalars → zero/sign-extended into x0
 * - 8-byte scalars/classes → `ldr x0, [x9]`
 * - strings (16 bytes) → the (ptr, len) pair in x0/x1
 * - larger structs → byte-copy into the x8 sret buffer; x0 = x8
 */
export function emit_index_load(elem: Type, status: BuildStatus) {
	const name = elem.name;
	const size = pointer_element_size(elem, status);
	if (name === "string") {
		emit_asm(status, `ldp x0, x1, [x9]\n`);
		return;
	}
	const is_struct = !!status.structs.find(
		(s) => s.name === name && !s.is_simple_type && !s.is_class,
	);
	if (is_struct && size > 8) {
		emit_asm(status, `mov x0, x8\n`);
		emit_asm(status, `mov x1, x9\n`);
		emit_asm(status, `mov x2, #${size}\n`);
		emit_asm(status, `bl _memcpy\n`);
		emit_asm(status, `mov x0, x8\n`);
		return;
	}
	emit_asm(status, `${scalar_load_instr(name, size)}\n`);
}

/** Width-matched store of the element at x9; the value follows the standard
 *  rvalue conventions (x0 scalar / x0+x1 string pair / x0 address for
 *  structs). */
export function emit_index_store(elem: Type, status: BuildStatus) {
	const name = elem.name;
	const size = pointer_element_size(elem, status);
	if (name === "string") {
		emit_asm(status, `stp x0, x1, [x9]\n`);
		return;
	}
	const is_struct = !!status.structs.find(
		(s) => s.name === name && !s.is_simple_type && !s.is_class,
	);
	if (is_struct && size > 8) {
		emit_asm(status, `mov x1, x0\n`);
		emit_asm(status, `mov x0, x9\n`);
		emit_asm(status, `mov x2, #${size}\n`);
		emit_asm(status, `bl _memcpy\n`);
		return;
	}
	emit_asm(status, `${scalar_store_instr(name, size)}\n`);
}

export function scalar_load_instr(name: string, size: number): string {
	const signed =
		name === "int" || name === "int8" || name === "int16" || name === "int32" || name === "int64";
	if (size === 1) return signed ? `ldrsb x0, [x9]` : `ldrb w0, [x9]`;
	if (size === 2) return signed ? `ldrsh x0, [x9]` : `ldrh w0, [x9]`;
	if (size === 4) return signed ? `ldrsw x0, [x9]` : `ldr w0, [x9]`;
	return `ldr x0, [x9]`;
}

export function scalar_store_instr(name: string, size: number): string {
	if (size === 1) return `strb w0, [x9]`;
	if (size === 2) return `strh w0, [x9]`;
	if (size === 4) return `str w0, [x9]`;
	return `str x0, [x9]`;
}

/**
 * The scale factor for a single-instruction scaled access
 * (`ldr x0, [x0, x1, lsl #k]`), or null when the width isn't a power of
 * two ≤ 8. Every scalar element width qualifies; strings (16) and larger
 * structs do not.
 */
export function scaled_load_shift(size: number): number | null {
	switch (size) {
		case 1:
			return 0;
		case 2:
			return 1;
		case 4:
			return 2;
		case 8:
			return 3;
	}
	return null;
}

/** Width-matched scaled load with the base in x0 and the index in x1. */
export function scaled_load_instr(name: string, size: number): string | null {
	const shift = scaled_load_shift(size);
	if (shift === null) return null;
	const signed =
		name === "int" || name === "int8" || name === "int16" || name === "int32" || name === "int64";
	if (size === 1) return signed ? `ldrsb x0, [x0, x1, lsl #0]` : `ldrb w0, [x0, x1, lsl #0]`;
	if (size === 2) return signed ? `ldrsh x0, [x0, x1, lsl #1]` : `ldrh w0, [x0, x1, lsl #1]`;
	if (size === 4) return signed ? `ldrsw x0, [x0, x1, lsl #2]` : `ldr w0, [x0, x1, lsl #2]`;
	return `ldr x0, [x0, x1, lsl #3]`;
}
