import type BuildStatus from "../build_c/BuildStatus.ts";
import type StructNode from "../nodes/StructNode.ts";

/**
 * Whether any field (recursively, through nested mv value structs)
 * is an owned `string`. Shared by BOTH backends' mv-Buffer element
 * specialization (the slot deep-copies strdup'd strings, so a
 * string-field element is mv even when `struct_needs_destroy`
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
 * STRUCT_PLAN_3 B1 cutover: whether this struct's plain `string` fields are
 * uniformly heap-owned under the declared-mv contract (ctor strdup's the
 * seed, stores strdup non-heap RHS, scope-exit destroy frees them
 * unconditionally). Compiler-generated tuple / anonymous structs are
 * excluded: their element lifecycle stays record/binding-based (destructured
 * bindings and tuple-var records take the string fields over; the temp is a
 * carrier), so the blanket strdup/destroy would leak or double-free.
 */
export function owns_strings_uniformly(node: StructNode): boolean {
	return (
		node.is_owning === true && !node.name.startsWith("_Tuple_") && !node.name.startsWith("_Anon_")
	);
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
