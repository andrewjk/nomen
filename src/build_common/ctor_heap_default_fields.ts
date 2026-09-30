import type BaseNode from "../nodes/BaseNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import { init_computed_heap_string_fields } from "./init_computed_seeds.ts";

/**
 * Record the string fields of `struct_node` whose value after construction
 * owns heap (per the backend's `is_owned_heap_temp`): either the DEFAULT is a
 * non-literal heap expression the constructor evaluates fresh at every
 * construction, or a custom `#init` COMPUTES the field's value
 * (`init_computed_heap_string_fields` — every direct `self.<field> = <expr>`
 * write stores a heap-owning expression, which also displaces the default).
 * Recording at the ctor-binding site makes scope exit free the seeded value,
 * and a displaced store (an override, a reassignment) reclaim it via the
 * record's old_was_heap check.
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
	const computed = init_computed_heap_string_fields(struct_node, is_owned_heap);
	for (const field of struct_node.fields) {
		if (field.type.name !== "string" || field.type.is_array) continue;
		if (field.type.is_ref || field.type.is_view) continue;
		if (skip?.has(field.name)) continue;
		const has_heap_default = !!field.value && is_owned_heap(field.value);
		if (!has_heap_default && !computed.has(field.name)) continue;
		if (!status.heap_string_fields) status.heap_string_fields = new Set<string>();
		status.heap_string_fields.add(`${var_name}.${field.name}`);
	}
}
