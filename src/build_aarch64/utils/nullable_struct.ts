import type BuildStatus from "../../build_c/BuildStatus.ts";
import type StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";

/**
 * Nullable struct value-type support (aarch64).
 *
 * Mirrors the C backend: a nullable struct value type (`T?`, T a non-class
 * struct) is stored inline at its natural size, with a companion 8-byte
 * `<slot>_has` flag immediately after it. `null` == flag 0. Struct layout
 * (get_struct_size / get_field_offset) accounts for the extra flag word; all
 * value/field access is unchanged.
 */

export function is_nullable_struct_type(type: Type | undefined, status: BuildStatus): boolean {
	if (!type?.is_nullable) return false;
	if (type.is_array || type.is_ref) return false;
	const s = type.name ? status.structs.find((s) => s.name === type.name) : undefined;
	return !!s && !s.is_class && !s.is_simple_type;
}

export function has_flag_name(name: string): string {
	return `${name}_has`;
}

/** Whether a struct has any nullable-struct field. */
export function has_nullable_struct_field(node: StructNode, status: BuildStatus): boolean {
	return node.fields.some((f) => is_nullable_struct_type(f.type, status));
}
