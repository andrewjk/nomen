import type BuildStatus from "../../build_c/BuildStatus.ts";
import {
	layout_enum_size,
	layout_field_offset,
	layout_field_offset_of_fields,
	layout_struct_size,
	layout_type_size,
	packed_layout_fields,
} from "../../build_common/layout.ts";
import DeclarationNode from "../../nodes/DeclarationNode.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import { emit_asm } from "./code_buffer.ts";
import { emit_pair_store_x29 } from "./string_pair.ts";

/**
 * Thin delegates over the shared layout model (build_common/layout.ts) —
 * the aarch64 offsets/sizes and the check-time META reflection
 * (META.size_of / META.align_of / META.offset_of) answer from the SAME
 * walk, so they cannot drift. The target defaults to the aarch64 ABI; see
 * layout.ts for the one C-target divergence (fixed stack-array fields).
 */

export function get_struct_size(name: string, status: BuildStatus): number {
	return layout_struct_size(name, status);
}

/**
 * The struct's fields in layout order, INCLUDING trait-declared fields that
 * the struct does not override. The C backend emits trait fields into the
 * typedef (the C compiler lays them out); the aarch64 layout must account for
 * them too, or a trait field's offset lands past the allocated instance.
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
	return packed_layout_fields(struct, status);
}

export function get_type_size(
	type: import("../../nodes/Type.ts").default,
	status: BuildStatus,
): number {
	return layout_type_size(type, status);
}

export function get_field_offset(
	struct_name: string,
	field_name: string,
	status: BuildStatus,
): number {
	return layout_field_offset(struct_name, field_name, status);
}

export function get_field_offset_of_fields(
	fields: DeclarationNode[],
	field_name: string,
	status: BuildStatus,
): number {
	return layout_field_offset_of_fields(fields, field_name, status);
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
	return layout_enum_size(enum_name, status);
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
