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
 * STRUCT_PLAN_3 B1 backend cutover — whether the struct has DIRECT owned
 * `string` fields (a `ref` alias, a `view` borrow, and a `string[N]` array
 * whose element-wise ctor copy borrows the caller's row are excluded, the
 * same convention `struct_needs_auto_destroy` and `has_string_fields` use).
 */
function struct_has_direct_string_fields(struct: StructNode): boolean {
	return struct.fields.some(
		(f) => !f.type.is_ref && !f.type.is_view && !f.type.is_array && f.type.name === "string",
	);
}

/**
 * STRUCT_PLAN_3 B1 cutover — whether this struct's plain `string` fields
 * participate in the uniform-heap destroy contract. Compiler-generated
 * tuple / anonymous structs are excluded: their element lifecycle stays
 * record/binding-based (destructured bindings and tuple-var records take
 * the string fields over; the temp is a carrier), so the blanket destroy
 * would free bytes the bindings own (or rodata literals).
 */
function owns_strings_via_destroy(struct: StructNode): boolean {
	return (
		struct.is_owning === true &&
		!struct.name.startsWith("_Tuple_") &&
		!struct.name.startsWith("_Anon_")
	);
}

/**
 * Whether any field (recursively) requires destroy handling — a class
 * field (heap instance to reclaim), a nested struct with its own
 * `#destroy` (or nested fields that do), or — B1 cutover — a nested
 * DECLARED-owning struct with direct string fields (its strings are
 * uniformly heap: the ctor strdup'd them, so the enclosing scope exit
 * must reclaim them through the nested field). Plain `string` fields of
 * a NON-owning struct are still excluded: such a local's strings may be
 * raw rodata arg pointers, not heap (the transition-era posture
 * `struct_needs_auto_destroy` extends). Tuple / anon struct fields stay
 * out (their element lifecycle is the bindings'/records').
 */
export function has_struct_fields_with_destroy(struct: StructNode, table: StructTable): boolean {
	for (const field of struct.fields) {
		if (field.type.is_ref) continue;
		const field_struct = resolve_struct_type(field.type, table);
		if (!field_struct) continue;
		if (field_struct.is_class) return true;
		if (has_destroy(field_struct)) return true;
		if (owns_strings_via_destroy(field_struct) && struct_has_direct_string_fields(field_struct))
			return true;
		if (has_struct_fields_with_destroy(field_struct, table)) return true;
	}
	return false;
}

/**
 * Whether a struct (or any embedded struct field, recursively) needs a
 * destroy call at scope exit — it has a `#destroy`, a class-typed field,
 * or a nested struct field that itself needs destroying. B1 cutover: a
 * DECLARED-owning struct with direct string fields also needs one — its
 * string fields are uniformly heap-owned (ctor strdup, stores strdup), so
 * the scope-exit destroy frees them (the destroy walkers pass
 * free_strings/emit the frees for owning structs). Non-owning structs'
 * string fields are still NOT counted (they may hold rodata borrows).
 */
export function struct_needs_destroy(struct: StructNode, table: StructTable): boolean {
	return (
		has_destroy(struct) ||
		has_struct_fields_with_destroy(struct, table) ||
		struct_has_owning_enum_field(struct, table) ||
		struct_has_owned_func_field(struct) ||
		(owns_strings_via_destroy(struct) && struct_has_direct_string_fields(struct))
	);
}

/**
 * Whether a class or OWNING struct has a `func`-typed field. Such a field may
 * hold a capturing-closure descriptor (`owned = 1`, a heap env + descriptor),
 * which the scope-exit / generated destroy must reclaim. A non-owning value
 * struct shares its descriptor (copies are non-owning) and frees nothing, so
 * it is excluded (CLOSURE.md Phase 2c).
 */
function struct_has_owned_func_field(struct: StructNode): boolean {
	if (!(struct.is_class === true || struct.is_owning === true)) return false;
	return struct.fields.some((f) => !f.type.is_ref && f.type.name === "func" && !f.type.is_array);
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
	if (struct_has_owned_func_field(struct)) return true;
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
