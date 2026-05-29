import type BuildStatus from "../../build/BuildStatus.ts";
import DeclarationNode from "../../nodes/DeclarationNode.ts";
import aarch64_size from "./aarch64_size.ts";

const VT_SIZE = 8;

export function get_struct_size(name: string, status: BuildStatus): number {
	const struct = status.structs.find((s) => s.name === name);
	if (!struct) return VT_SIZE;
	if (struct.is_simple_type) return VT_SIZE;
	let size = VT_SIZE;
	for (const field of struct.fields) {
		size += get_type_size(field.type, status);
	}
	return size;
}

function get_type_size(type: import("../../nodes/Type.ts").default, status: BuildStatus): number {
	if (type.is_ref) return 8;
	const struct = status.structs.find((s) => s.name === type.name && !s.is_simple_type);
	if (struct) {
		if (struct.is_class) return 8;
		return get_struct_size(type.name, status);
	}
	return aarch64_size(type.name);
}

export function get_field_offset(
	struct_name: string,
	field_name: string,
	status: BuildStatus,
): number {
	const struct = status.structs.find((s) => s.name === struct_name);
	if (!struct) return VT_SIZE;
	let offset = VT_SIZE;
	for (const field of struct.fields) {
		if (field.name === field_name) return offset;
		offset += get_type_size(field.type, status);
	}
	return offset;
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
