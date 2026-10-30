import { is_box_type } from "../check/utils/box.ts";
import type EnumNode from "../nodes/EnumNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import type Type from "../nodes/Type.ts";
import {
	enum_payload_deep_copy_struct,
	enum_payload_destroy_struct,
	has_destroy,
	struct_needs_auto_destroy,
} from "./destroy_analysis.ts";
import { owns_strings_uniformly } from "./has_string_fields.ts";
import { resolve_struct_type, type StructTable } from "./mono_name.ts";

/**
 * The load/transfer deep-copy story for `Box<T>` FIELDS on mv struct elements
 * of mv containers (2026-10-12, the Valen-comparison repro): a
 * `List<Ship>` whose `Ship` holds `var Box<Engine> engine` used to come back
 * from `load_T` with the element's box SHALLOW — the copy's scope-exit
 * destroy freed the slot's shared wrapper (SIGTRAP on the next use). `Box<T>`
 * joins the deep-copy/transfer set: `load_T` clones the wrapper
 * (`<Box_T>_box_clone` — malloc + byte copy + fresh copies of the pointee's
 * owned fields), and `store_T`/`replace_T` transfer it (the donor's field is
 * zeroed — the slot is the sole owner). The clone helper is emitted lazily
 * per backend (this module carries only the shared predicates).
 */

/** The clone helper's symbol for a Box mono (`Box_Engine` → `Box_Engine_box_clone`). */
export function box_clone_fn_name(box_mono_name: string): string {
	return `${box_mono_name}_box_clone`;
}

/**
 * The monomorphized `Box<T>` wrapper when `type` is a box field type, else
 * undefined. Shape-checked through `is_box_type` (single `__value` field,
 * compiler-stamped storage class), so a USER struct named `Box_*` is not
 * mistaken for the wrapper.
 */
export function box_field_mono(type: Type, table: StructTable): StructNode | undefined {
	if (!type.name || type.is_ref || type.is_view || type.is_array) return undefined;
	const mono = resolve_struct_type(type, table);
	if (!mono || !mono.is_class) return undefined;
	return is_box_type(mono.name, table.structs) ? mono : undefined;
}

/** The `__value` field's type (the pointee). The wrapper is shape-checked to
 *  have exactly one field. */
export function box_pointee_type(box_mono: StructNode): Type | undefined {
	return box_mono.fields[0]?.type;
}

/** Whether `<E>_copy` yields a fully independent value: no case payload is a
 *  class/trait reference (those are shared pointers the copy cannot
 *  duplicate — a cloned blob sharing one would free it twice at teardown),
 *  and no case payload is a mv struct whose owned state lacks a deep-copy
 *  story (the copy arm deep-copies payloads via their `copy`; an owning
 *  payload without one would share heap state both deaths destroy — the same
 *  non-copyable posture as reference payloads). */
export function enum_copy_is_deep(
	elem: EnumNode,
	table: StructTable & { traits?: { name: string }[] },
): boolean {
	for (const c of elem.cases) {
		for (const p of c.params) {
			const ps = table.structs.find((s) => s.name === p.type.name);
			if (ps?.is_class || table.traits?.some((t) => t.name === p.type.name)) return false;
			if (enum_payload_destroy_struct(p, table) && !enum_payload_deep_copy_struct(p, table))
				return false;
		}
	}
	return true;
}

/**
 * Whether the pointee's plain `string` fields are heap-owned by the wrapper —
 * the same gate the box CONSTRUCTOR uses when normalizing the incoming value
 * (build_declaration_node's boxing path): an OWNING pointee's strings are
 * uniformly heap (transferred as-is), and a pointee without a user `#destroy`
 * that needs the auto destroy had its rodata/borrow fields strdup'd at
 * boxing. Anything else (a non-owning pointee with a user `#destroy`) may
 * still hold borrowed bytes the wrapper destroy never frees — the clone must
 * NOT strdup those (it would leak per clone).
 */
export function box_pointee_strings_are_heap(pointee: StructNode, table: StructTable): boolean {
	return (
		owns_strings_uniformly(pointee) ||
		(!has_destroy(pointee) && struct_needs_auto_destroy(pointee, table))
	);
}
