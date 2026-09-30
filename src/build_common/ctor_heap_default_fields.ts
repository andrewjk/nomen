import type BaseNode from "../nodes/BaseNode.ts";
import type StructNode from "../nodes/StructNode.ts";

/**
 * Record the string fields of `struct_node` whose DEFAULT is a non-literal
 * expression producing a heap-owning value (per the backend's
 * `is_owned_heap_temp`): the constructor evaluates such a default fresh at
 * every construction, so the constructed struct alone owns the buffer.
 * Recording at the ctor-binding site makes scope exit free the evaluated
 * default, and a displaced store (an override, a reassignment) reclaim it
 * via the record's old_was_heap check.
 *
 * `is_owned_heap` classifies the seed EXPRESSION per backend: both treat a
 * string-typed `op` as fresh heap; for calls the C backend's blanket strdup
 * makes every non-borrow string return owned, while the aarch64 backend
 * requires the heap-returning classification (a literal-returning user
 * function leaves rodata in the field — never recorded, never freed).
 *
 * `skip` names fields whose seed is reclaimed elsewhere (the C backend's
 * explicit displaced free ahead of an override store). Value structs only —
 * a class's string fields are always heap and freed by its destroy.
 */
export default function record_ctor_heap_default_fields(
	var_name: string,
	struct_node: StructNode,
	status: { heap_string_fields?: Set<string> },
	is_owned_heap: (seed: BaseNode) => boolean,
	skip?: ReadonlySet<string>,
): void {
	for (const field of struct_node.fields) {
		if (!field.value) continue;
		if (field.type.name !== "string" || field.type.is_array) continue;
		if (field.type.is_ref || field.type.is_view) continue;
		if (skip?.has(field.name)) continue;
		if (!is_owned_heap(field.value)) continue;
		if (!status.heap_string_fields) status.heap_string_fields = new Set<string>();
		status.heap_string_fields.add(`${var_name}.${field.name}`);
	}
}
