import type BuildStatus from "../../build_c/BuildStatus.ts";
import { is_nullable_scalar_type } from "../../build_common/nullable_scalar.ts";
import { is_nullable_struct_type } from "../../build_common/nullable_struct.ts";
import { packed_own_fields, packed_trait_extra_fields } from "../../build_common/struct_packing.ts";
import { get_built_in_type } from "../../built_in_types.ts";
import DeclarationNode from "../../nodes/DeclarationNode.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import aarch64_size from "./aarch64_size.ts";
import { emit_asm } from "./code_buffer.ts";
import { emit_pair_store_x29 } from "./string_pair.ts";

const VT_SIZE = 8;

/**
 * Natural alignment of a type in bytes — must match C struct layout rules,
 * because raw `#arch: c` bodies and companion code read the SAME fields
 * through C's naturally-aligned layout. Sub-8-byte scalars (bool, char,
 * int8/16/32) align to their own storage width (BuiltInTypeInfo.bytes);
 * everything else (word-sized ints, floats, fat strings, pointers, nested
 * structs) aligns to 8.
 */
function get_type_alignment(
	type: import("../../nodes/Type.ts").default,
	status: BuildStatus,
): number {
	// A `view T` field is a (ptr, len) pair of words — 8-byte aligned like
	// every other pointer-bearing value (checked before the struct lookup so
	// a view OF a struct doesn't recurse into element layout rules).
	if (type.is_view) return 8;
	const struct = status.structs.find((s) => s.name === type.name && !s.is_simple_type);
	if (type.is_ref || (struct && struct.is_class)) return 8;
	if (struct) return 8;
	const enum_node = status.enums.find((e) => e.name === type.name);
	if (enum_node) return 8;
	if (type.is_array) return 8;
	switch (get_built_in_type(type.name)?.bytes) {
		case 1:
		case 2:
		case 4:
			return get_built_in_type(type.name)!.bytes!;
		default:
			return 8;
	}
}

/** Round `offset` up to `alignment` (alignment is a power of two). */
function align_to(offset: number, alignment: number): number {
	return Math.ceil(offset / alignment) * alignment;
}

export function get_struct_size(name: string, status: BuildStatus): number {
	const struct = status.structs.find((s) => s.name === name);
	if (!struct) return VT_SIZE;
	if (struct.is_simple_type) return VT_SIZE;
	let size = VT_SIZE;
	for (const field of layout_fields(struct, status)) {
		size = align_to(size, get_type_alignment(field.type, status));
		size += get_type_size(field.type, status);
		// A nullable struct field carries a companion 8-byte `_has` flag; a
		// nullable scalar field a 1-byte `_has` flag right after the scalar
		// (both match C's `unsigned char <f>_has;` member layout).
		if (is_nullable_struct_type(field.type, status)) size += 8;
		else if (is_nullable_scalar_type(field.type, status)) size += 1;
	}
	// Tail padding to the strictest member alignment so arrays of the struct
	// keep every element aligned (matches C's sizeof).
	size = align_to(size, 8);
	return size;
}

/**
 * The struct's fields in layout order, INCLUDING trait-declared fields that
 * the struct does not override. The C backend emits trait fields into the
 * typedef (the C compiler lays them out); the aarch64 layout must account for
 * them too, or a trait field's offset lands past the allocated instance.
 *
 * Own fields are PACKED (alignment-descending — see
 * build_common/struct_packing.ts) unless the struct is excluded (raw `#arch`
 * bodies, tuples, fixed-array fields); trait extras follow, packed among
 * themselves. Field declaration order is untouched on the node itself — the
 * positional `#init` contract depends on it.
 */
export function layout_fields(
	struct: {
		name?: string;
		fields: DeclarationNode[];
		traits?: string[];
		functions?: FunctionNode[];
	},
	status: BuildStatus,
): DeclarationNode[] {
	const own = packed_own_fields(struct);
	if (!struct.traits?.length) return own;
	const extra = packed_trait_extra_fields(struct, status.traits);
	return extra.length ? [...own, ...extra] : own;
}

export function get_type_size(
	type: import("../../nodes/Type.ts").default,
	status: BuildStatus,
): number {
	if (type.is_ref) return 8;
	// A `view T` is the universal (ptr, len) pair — 16 bytes regardless of
	// the element type (a view of a struct is a slice, NOT the struct value).
	if (type.is_view) return 16;
	const struct = status.structs.find((s) => s.name === type.name && !s.is_simple_type);
	if (struct) {
		if (struct.is_class) return 8;
		return get_struct_size(type.name, status);
	}
	// Enums: an enum with associated data is multi-word (tag + payload), so its
	// size must come from get_enum_size, not the default 8 — otherwise struct
	// field offsets and struct sizes under-count a 16-byte enum and the next
	// field overlaps its payload.
	const enum_node = status.enums.find((e) => e.name === type.name);
	if (enum_node) {
		return get_enum_size(type.name, status);
	}
	const element_size = aarch64_size(type.name);
	if (type.is_array && type.length && (type.length.start ?? -1) >= 0) {
		const length = parseInt((type.length as ValueNode).value || "0");
		return 8 + element_size * length;
	}
	return element_size;
}

export function get_field_offset(
	struct_name: string,
	field_name: string,
	status: BuildStatus,
): number {
	const struct = status.structs.find((s) => s.name === struct_name);
	if (!struct) return VT_SIZE;
	return get_field_offset_of_fields(layout_fields(struct, status), field_name, status);
}

/**
 * Aligned field-offset walk shared by every consumer of struct layout
 * (field access, destroy emission, ctor copies): each field starts at the
 * next position aligned to its natural alignment, with an extra 8-byte
 * `_has` flag word after a nullable struct field.
 */
export function get_field_offset_of_fields(
	fields: DeclarationNode[],
	field_name: string,
	status: BuildStatus,
): number {
	let offset = VT_SIZE;
	for (const field of fields) {
		offset = align_to(offset, get_type_alignment(field.type, status));
		if (field.name === field_name) return offset;
		offset += get_type_size(field.type, status);
		// Skip the companion `_has` flag following a nullable struct field
		// (8-byte word) or nullable scalar field (1 byte).
		if (is_nullable_struct_type(field.type, status)) offset += 8;
		else if (is_nullable_scalar_type(field.type, status)) offset += 1;
	}
	return offset;
}

/**
 * Offset of a nullable struct field's companion `_has` flag (the word
 * immediately after the field's value storage).
 */
export function get_field_has_offset(
	struct_name: string,
	field_name: string,
	status: BuildStatus,
): number {
	return (
		get_field_offset(struct_name, field_name, status) +
		get_type_size_for_field(struct_name, field_name, status)
	);
}

function get_type_size_for_field(
	struct_name: string,
	field_name: string,
	status: BuildStatus,
): number {
	const struct = status.structs.find((s) => s.name === struct_name);
	if (!struct) return 0;
	const field = layout_fields(struct, status).find((f) => f.name === field_name);
	if (!field) return 0;
	return get_type_size(field.type, status);
}

export function get_field(
	struct_name: string,
	field_name: string,
	status: BuildStatus,
): DeclarationNode | undefined {
	const struct = status.structs.find((s) => s.name === struct_name);
	if (!struct) return undefined;
	return struct.fields.find((f) => f.name === field_name);
}

export function get_enum_size(enum_name: string, status: BuildStatus): number {
	const enum_node = status.enums.find((e) => e.name === enum_name);
	if (!enum_node || !enum_node.has_associated_data) return 8;
	let max_payload = 0;
	for (const c of enum_node.cases) {
		let case_size = 0;
		for (const p of c.params) {
			// Use get_type_size, not aarch64_size: a struct payload (e.g. a
			// string-bearing value struct) is multi-word, and sizing it as one
			// word truncated the enum blob and mis-offset every later payload.
			case_size += get_type_size(p.type, status);
		}
		max_payload = Math.max(max_payload, case_size);
	}
	return 8 + Math.ceil(max_payload / 8) * 8;
}

/**
 * The sret size for an enum-with-data return type, or undefined when `name`
 * is not an enum that uses the sret convention. Enums with associated data
 * ride the SAME caller-provided x8 buffer convention as structs: a plain x0
 * return would hand the caller a pointer into the callee's (now dead) stack
 * frame, which any intervening call clobbers. Simple enums (no associated
 * data) are 8-byte scalars returned in x0 — no sret.
 */
export function get_enum_sret_size(
	name: string | undefined,
	status: BuildStatus,
): number | undefined {
	if (!name) return undefined;
	const enum_node = status.enums.find((e) => e.name === name);
	if (!enum_node?.has_associated_data) return undefined;
	return get_enum_size(name, status);
}

export function get_enum_payload_offset(
	enum_name: string,
	case_name: string,
	field_name: string,
	status: BuildStatus,
): number {
	const enum_node = status.enums.find((e) => e.name === enum_name);
	if (!enum_node) return 8;
	const case_ = enum_node.cases.find((c) => c.name === case_name);
	if (!case_) return 8;
	let offset = 8;
	for (const p of case_.params) {
		if (p.name === field_name) return offset;
		offset += get_type_size(p.type, status);
	}
	return 8;
}

export function get_enum_case_index(
	enum_name: string,
	case_name: string,
	status: BuildStatus,
): number {
	const enum_node = status.enums.find((e) => e.name === enum_name);
	if (!enum_node) return 0;
	const idx = enum_node.cases.findIndex((c) => c.name === case_name);
	if (idx < 0) return idx;
	// A case-mono enum (variable-mode `Res.ok` → `Res_ok`) holds its single
	// case at position 0, but the tag VALUE is the base case's declaration
	// index — recorded on the case at check time. Every caller here compares
	// or stores a tag, never an array position.
	return enum_node.cases[idx].tag_index ?? idx;
}

export function emit_struct_copy(
	src_addr_reg: string,
	dst_base_reg: string,
	dst_offset: number,
	struct_size: number,
	status: BuildStatus,
) {
	const words = Math.ceil(struct_size / 8);
	for (let i = 0; i < words; i++) {
		emit_asm(status, `ldr x3, [${src_addr_reg}, #${i * 8}]\n`);
		if (dst_offset + i * 8 === 0) {
			emit_asm(status, `str x3, [${dst_base_reg}]\n`);
		} else {
			emit_asm(status, `str x3, [${dst_base_reg}, #${dst_offset + i * 8}]\n`);
		}
	}
}

/**
 * Copy an enum-with-data payload of `type` out of the enum blob at
 * `[base_reg + payload_off]` into the frame slot `[x29 + slot]`.
 *
 * A payload can be wider than one word (a value struct, or a nested
 * enum-with-data blob), so a single 8-byte load is wrong — it truncates the
 * value and leaves a struct binding holding a partial/pointless pointer, which
 * crashes on the first field read. Multi-word payloads are copied word-by-word
 * (the same copy `emit_struct_copy` emits elsewhere); scalars and the fat
 * string pair use their width-matched load.
 */
export function emit_enum_payload_binding_load(
	status: BuildStatus,
	base_reg: string,
	payload_off: number,
	slot: number,
	type: import("../../nodes/Type.ts").default,
) {
	if (type.name === "string") {
		emit_asm(status, `ldp x9, x11, [${base_reg}, #${payload_off}]\n`);
		emit_pair_store_x29(status, slot, "x9", "x11");
		return;
	}
	const size = get_type_size(type, status);
	if (size === 1) {
		emit_asm(status, `ldrb w9, [${base_reg}, #${payload_off}]\n`);
		emit_asm(status, `strb w9, [x29, #${slot}]\n`);
	} else if (size === 2) {
		emit_asm(status, `ldrh w9, [${base_reg}, #${payload_off}]\n`);
		emit_asm(status, `strh w9, [x29, #${slot}]\n`);
	} else if (size === 4) {
		emit_asm(status, `ldr w9, [${base_reg}, #${payload_off}]\n`);
		emit_asm(status, `str w9, [x29, #${slot}]\n`);
	} else if (size === 8) {
		emit_asm(status, `ldr x9, [${base_reg}, #${payload_off}]\n`);
		emit_asm(status, `str x9, [x29, #${slot}]\n`);
	} else {
		// Multi-word value payload (struct / enum-with-data): copy every word.
		if (payload_off !== 0) {
			emit_asm(status, `add x9, ${base_reg}, #${payload_off}\n`);
		}
		emit_struct_copy(payload_off !== 0 ? "x9" : base_reg, "x29", slot, size, status);
	}
}
