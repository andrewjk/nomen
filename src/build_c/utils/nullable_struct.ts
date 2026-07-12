import type StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * Nullable struct value-type support.
 *
 * A nullable struct value type (`T?` where T is a non-class struct) is stored
 * inline as the struct value itself, alongside a companion boolean flag named
 * `<slot>_has` (a sibling local variable for locals/params, or a sibling field
 * for struct fields). `null` is represented by the flag being 0.
 *
 * This keeps the struct value at its natural storage/location, so all existing
 * field-access, value-use, parameter-passing, return, and interpolation code
 * works unchanged — only null checks, assignments, declarations, layout, and
 * auto-free need to know about the companion flag.
 *
 * The flag expression for any nullable-struct lvalue is just its built
 * expression with `_has` appended (`x` → `x_has`, `s.g` → `s.g_has`,
 * `s->g` → `s->g_has`), because every nullable-struct lvalue expression ends
 * in an identifier (a variable or field name).
 */

/** True if `type` is a nullable, non-class, non-array struct value type. */
export function is_nullable_struct_type(type: Type | undefined, status: BuildStatus): boolean {
	if (!type?.is_nullable) return false;
	if (type.is_array || type.is_ref) return false;
	const s = type.name ? status.structs.find((s) => s.name === type.name) : undefined;
	return !!s && !s.is_class && !s.is_simple_type;
}

/** Whether a struct has any nullable-struct field (so its layout needs flags). */
export function has_nullable_struct_field(node: StructNode, status: BuildStatus): boolean {
	return node.fields.some((f) => is_nullable_struct_type(f.type, status));
}

/** The companion flag name for a slot (variable or field) named `name`. */
export function has_flag_name(name: string): string {
	return `${name}_has`;
}
