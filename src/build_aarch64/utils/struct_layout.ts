import type BuildStatus from "../../build_c/BuildStatus.ts";
import DeclarationNode from "../../nodes/DeclarationNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import aarch64_size from "./aarch64_size.ts";
import { is_nullable_struct_type } from "./nullable_struct.ts";

const VT_SIZE = 8;

/**
 * Natural alignment of a type in bytes — must match C struct layout rules,
 * because raw `#arch: c` bodies and companion code read the SAME fields
 * through C's naturally-aligned layout. Sub-8-byte scalars (bool, char,
 * int8/16/32) align to their own width; everything else (ints, floats, fat
 * strings, pointers, nested structs) aligns to 8.
 */
function get_type_alignment(
	type: import("../../nodes/Type.ts").default,
	status: BuildStatus,
): number {
	const struct = status.structs.find((s) => s.name === type.name && !s.is_simple_type);
	if (type.is_ref || (struct && struct.is_class)) return 8;
	if (struct) return 8;
	const enum_node = status.enums.find((e) => e.name === type.name);
	if (enum_node) return 8;
	if (type.is_array) return 8;
	switch (type.name) {
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
	for (const field of struct.fields) {
		size = align_to(size, get_type_alignment(field.type, status));
		size += get_type_size(field.type, status);
		// A nullable struct field carries a companion 8-byte `_has` flag.
		if (is_nullable_struct_type(field.type, status)) size += 8;
	}
	// Tail padding to the strictest member alignment so arrays of the struct
	// keep every element aligned (matches C's sizeof).
	size = align_to(size, 8);
	return size;
}

export function get_type_size(
	type: import("../../nodes/Type.ts").default,
	status: BuildStatus,
): number {
	if (type.is_ref) return 8;
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
	return get_field_offset_of_fields(struct.fields, field_name, status);
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
		// Skip the companion `_has` flag word following a nullable struct field.
		if (is_nullable_struct_type(field.type, status)) offset += 8;
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
	const field = struct?.fields.find((f) => f.name === field_name);
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
			case_size += aarch64_size(p.type.name);
		}
		max_payload = Math.max(max_payload, case_size);
	}
	return 8 + Math.ceil(max_payload / 8) * 8;
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
		offset += aarch64_size(p.type.name);
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
	return enum_node.cases.findIndex((c) => c.name === case_name);
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
		status.code += `ldr x3, [${src_addr_reg}, #${i * 8}]\n`;
		if (dst_offset + i * 8 === 0) {
			status.code += `str x3, [${dst_base_reg}]\n`;
		} else {
			status.code += `str x3, [${dst_base_reg}, #${dst_offset + i * 8}]\n`;
		}
	}
}
