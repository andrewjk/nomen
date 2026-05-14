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
		size += get_type_size(field.type.name, status);
	}
	return size;
}

function get_type_size(type_name: string, status: BuildStatus): number {
	const struct = status.structs.find((s) => s.name === type_name && !s.is_simple_type);
	if (struct) {
		return get_struct_size(type_name, status);
	}
	return aarch64_size(type_name);
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
		offset += get_type_size(field.type.name, status);
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
