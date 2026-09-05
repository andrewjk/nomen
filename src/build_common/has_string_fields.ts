import type StructNode from "../nodes/StructNode.ts";
import type BuildStatus from "../build_c/BuildStatus.ts";

/**
 * Whether any field (recursively, through nested owning value structs)
 * is an owned `string`. Shared by BOTH backends' owning-Buffer element
 * specialization (the slot deep-copies strdup'd strings, so a
 * string-field element is owning even when `struct_needs_destroy`
 * ignores string-only locals) — the C comment in
 * owning_buffer_specialize records the divergence this once caused.
 * `ref` and `view T` fields are skipped: a ref aliases the caller's
 * storage and a view's byte copy owns nothing.
 */
export function has_string_fields(node: StructNode, status: BuildStatus): boolean {
	for (const field of node.fields) {
		if (field.type.is_ref) continue;
		if (field.type.is_view) continue;
		if (field.type.name === "string" && !field.type.is_array) return true;
		const field_struct = status.structs.find(
			(s) => s.name === field.type.name && !s.is_simple_type && !s.is_generic,
		);
		if (field_struct && !field_struct.is_class && has_string_fields(field_struct, status))
			return true;
	}
	return false;
}
