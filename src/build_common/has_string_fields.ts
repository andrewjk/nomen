import type BuildStatus from "../build_c/BuildStatus.ts";
import type StructNode from "../nodes/StructNode.ts";

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

/**
 * The DIRECT `string` fields of a value struct (nested struct fields are not
 * descended into — nested string fields are outside the per-field ownership
 * tracking everywhere else too). Used by the return-boundary normalization:
 * the returned struct's unrecorded fields are strdup'd so the value the
 * caller receives is uniformly heap-owned.
 */
export function direct_string_fields(node: StructNode): StructNode["fields"] {
	return node.fields.filter(
		(f) => !f.type.is_ref && !f.type.is_view && !f.type.is_array && f.type.name === "string",
	);
}
