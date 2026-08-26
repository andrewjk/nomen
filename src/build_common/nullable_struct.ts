import type StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";

/**
 * Nullable struct value-type support (shared by both backends).
 *
 * A nullable struct value type (`T?` where T is a non-class struct) is stored
 * inline as the struct value itself, alongside a companion boolean flag named
 * `<slot>_has` (a sibling local variable for locals/params, or a sibling field
 * for struct fields). `null` is represented by the flag being 0.
 *
 * This keeps the struct value at its natural storage/location, so all existing
 * field-access, value-use, parameter-passing, return, and interpolation code
 * works unchanged — only null checks, assignments, declarations, layout, and
 * auto-free need to know about the companion flag. The C backend appends
 * `_has` to the flag expression; the aarch64 backend stores an 8-byte flag
 * word right after the struct — same predicate, same name rule on both sides.
 */

/** The struct table the predicates need; both backends' BuildStatus satisfy it. */
interface NullableStructTable {
	structs: StructNode[];
}

/** True if `type` is a nullable, non-class, non-array struct value type. */
export function is_nullable_struct_type(
	type: Type | undefined,
	status: NullableStructTable,
): boolean {
	if (!type?.is_nullable) return false;
	if (type.is_array || type.is_ref) return false;
	const s = type.name ? status.structs.find((s) => s.name === type.name) : undefined;
	return !!s && !s.is_class && !s.is_simple_type;
}

/** Whether a struct has any nullable-struct field (so its layout needs flags). */
export function has_nullable_struct_field(node: StructNode, status: NullableStructTable): boolean {
	return node.fields.some((f) => is_nullable_struct_type(f.type, status));
}

/** The companion flag name for a slot (variable or field) named `name`. */
export function has_flag_name(name: string): string {
	return `${name}_has`;
}
