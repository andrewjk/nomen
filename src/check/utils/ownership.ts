import type CheckStatus from "../CheckStatus.ts";

export function is_class_type(type_name: string, status: CheckStatus): boolean {
	return !!status.structs.find((s) => s.name === type_name && s.is_class);
}

export function struct_has_class_fields(type_name: string, status: CheckStatus): boolean {
	const struct = status.structs.find((s) => s.name === type_name && !s.is_simple_type);
	if (!struct) return false;
	return struct.fields.some((f) => is_class_type(f.type.name, status));
}
