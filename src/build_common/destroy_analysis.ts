import type StructNode from "../nodes/StructNode.ts";
import type { StructTable } from "./mono_name.ts";
import { resolve_struct_type } from "./mono_name.ts";

/**
 * Optional enums/traits views callers may provide alongside the struct table
 * (both backends' BuildStatus carry them). Used to detect enum-with-data
 * fields whose payloads a struct owns.
 */
interface EnumFieldView {
	name: string;
	has_associated_data?: boolean;
	cases: { params: { type: { name: string; is_array?: boolean } }[] }[];
}

interface EnumAwareTable extends StructTable {
	enums?: EnumFieldView[];
	traits?: { name: string }[];
}

/**
 * Whether any field of the struct is an enum-with-data value owning heap
 * payloads (a string payload — always heap, case construction strdups it —
 * or a class/trait reference payload — construction transfers ownership).
 * Such a field must be reclaimed when the struct dies.
 */
function struct_has_owning_enum_field(struct: StructNode, table: EnumAwareTable): boolean {
	for (const field of struct.fields) {
		if (field.type.is_ref) continue;
		const en = table.enums?.find((e) => e.name === field.type.name);
		if (!en?.has_associated_data) continue;
		for (const c of en.cases) {
			for (const p of c.params) {
				if (p.type.name === "string" && !p.type.is_array) return true;
				if (table.traits?.some((t) => t.name === p.type.name)) return true;
				const ps = table.structs.find((s) => s.name === p.type.name);
				if (ps?.is_class) return true;
			}
		}
	}
	return false;
}

/**
 * Whether a struct declares its own `#destroy` (user side effects /
 * resource release).
 */
export function has_destroy(struct: StructNode): boolean {
	return !!struct.functions.find((f) => f.name === "#destroy");
}

/**
 * Whether any field (recursively) requires destroy handling — a class
 * field (heap instance to reclaim) or a nested struct with its own
 * `#destroy` (or nested fields that do). Deliberately excludes `string`
 * fields: a struct local whose only owning fields are strings is NOT
 * auto-destroyed at scope exit (the strings may be raw rodata arg
 * pointers, not heap) — see `struct_needs_auto_destroy` for the broader
 * form used to decide whether a `<Struct>_destroy` function is generated.
 */
export function has_struct_fields_with_destroy(struct: StructNode, table: StructTable): boolean {
	for (const field of struct.fields) {
		if (field.type.is_ref) continue;
		const field_struct = resolve_struct_type(field.type, table);
		if (!field_struct) continue;
		if (field_struct.is_class) return true;
		if (has_destroy(field_struct)) return true;
		if (has_struct_fields_with_destroy(field_struct, table)) return true;
	}
	return false;
}

/**
 * Whether a struct (or any embedded struct field, recursively) needs a
 * destroy call at scope exit — it has a `#destroy`, a class-typed field,
 * or a nested struct field that itself needs destroying. This does NOT
 * count `string` fields (see `has_struct_fields_with_destroy`).
 */
export function struct_needs_destroy(struct: StructNode, table: StructTable): boolean {
	return (
		has_destroy(struct) ||
		has_struct_fields_with_destroy(struct, table) ||
		struct_has_owning_enum_field(struct, table)
	);
}

/**
 * Whether a struct needs an auto-generated `<Struct>_destroy` function.
 * Broader than `struct_needs_destroy`: also returns true for structs with
 * `string` fields, because a Buffer<T> for such a struct deep-copies the
 * strings into slots (strdup on store) and the per-element destroy must
 * free them. The generated destroy frees each string field; it is called
 * from Buffer's specialized #destroy / replace_T, NOT from struct local
 * scope exit (`struct_needs_destroy` governs that path and excludes
 * strings).
 */
export function struct_needs_auto_destroy(struct: StructNode, table: StructTable): boolean {
	if (struct_needs_destroy(struct, table)) return true;
	if (struct_has_owning_enum_field(struct, table)) return true;
	for (const field of struct.fields) {
		if (field.type.is_ref) continue;
		// A `view T` field is a non-owning borrow — nothing to free, so it
		// never triggers an auto-generated destroy.
		if (field.type.is_view) continue;
		if (field.type.name === "string" && !field.type.is_array) return true;
		const field_struct = resolve_struct_type(field.type, table);
		if (field_struct && !field_struct.is_class && struct_needs_auto_destroy(field_struct, table))
			return true;
	}
	return false;
}
