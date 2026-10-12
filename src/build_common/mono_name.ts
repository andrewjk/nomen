import type StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";

/**
 * Minimal structural view of a build status: everything the shared build
 * helpers need is the table of (generic + monomorphized) structs. Both
 * backends' BuildStatus satisfy this shape, so the shared layer never
 * imports a backend-specific status type.
 */
export interface StructTable {
	structs: StructNode[];
}

/**
 * Whether `name` is a monomorphized mv-container struct whose
 * `<Mono>_copy` is safe to call from the mv-`Buffer.load_T`
 * specialization — `List_<T>` / `Buffer_<T>` / `Map_<K,V>` / `Set_<T>`
 * (and their bare generics). These own heap slabs their `#destroy` frees
 * unconditionally, and `copy` yields an independent slab, so a returned
 * element's field must be deep-copied or the caller's unconditional
 * container-field teardown double-frees the slot's slab.
 *
 * `Map`/`Set` compose their `copy` from member `Buffer.copy` calls (and a
 * zero-pair `Map()`/`Set()` ctor); the aarch64 deferred-ctor marshalling
 * that crashed that composition is fixed (see build_constructor_params),
 * so they ride the same deep copy.
 */
export function is_load_deep_copy_container(name: string): boolean {
	return (
		name === "List" ||
		name === "Buffer" ||
		name === "Map" ||
		name === "Set" ||
		name.startsWith("List_") ||
		name.startsWith("Buffer_") ||
		name.startsWith("Map_") ||
		name.startsWith("Set_")
	);
}

/**
 * Flatten a possibly-generic type to its monomorphized name
 * (`List` + `<int>` → `List_int`); a type without type args is returned
 * unchanged. Accepts a full `Type`, or a `(type_name, type_args?)` pair for
 * sites that already rewrote the name (e.g. heap `Array<T>`'s parse-time
 * `{name: T, is_array_heap}` rewrite). This is the ONE definition of the
 * flattening — the backends previously inlined it at a dozen sites.
 */
export function mono_type_name(type: Type): string;
export function mono_type_name(type_name: string, type_args?: Type[]): string;
export function mono_type_name(type_or_name: Type | string, type_args?: Type[]): string {
	const name = typeof type_or_name === "string" ? type_or_name : type_or_name.name;
	const args = typeof type_or_name === "string" ? type_args : type_or_name.type_args;
	// Recurse into the args so a NESTED instantiation
	// (`Wrapper<List<int>>`) flattens all the way down (`Wrapper_List_int`)
	// — a name-only `t.name` join would drop the inner args (`Wrapper_List`).
	return args?.length ? `${name}_${args.map((t) => mono_type_name(t)).join("_")}` : name;
}

/**
 * Resolve a possibly-generic type to its registered monomorphized
 * StructNode. Strict by design: a field/param type carrying type args must
 * resolve to the mono struct (materialized at check time by
 * `instantiate_generic_type`); generics and simple types never match — the
 * bare generic has no emitted body, so treating it as a field struct would
 * emit calls to undefined symbols (`struct List` incomplete-type errors).
 */
export function resolve_struct_type(type: Type, table: StructTable): StructNode | undefined {
	return table.structs.find(
		(s) => s.name === mono_type_name(type) && !s.is_simple_type && !s.is_generic,
	);
}

/**
 * The monomorphized name of a generic type applied to concrete args, when a
 * non-generic mono struct is registered for it — otherwise the plain type
 * name. Used where a signature/field must name the mono struct ONLY if it
 * exists (the bare generic would be an incomplete type / undefined symbol).
 */
export function mono_struct_name(type: Type, table: StructTable): string {
	if (!type.type_args?.length) return type.name;
	const mono_name = mono_type_name(type);
	return table.structs.find((s) => s.name === mono_name && !s.is_generic) ? mono_name : type.name;
}

/**
 * Rewrite a generic-annotated type (`Wrapper<List<int>>`) to a copy whose
 * name is the registered mono struct (`Wrapper_List_int`, args cleared),
 * so layout/size/dispatch resolution keyed by `type.name` sees the
 * concrete struct instead of the bare generic (whose type-param fields
 * have no concrete size). Returns the type unchanged when there is no
 * registered mono for it.
 */
export function resolve_mono_type(type: Type, table: StructTable): Type {
	if (!type.type_args?.length) return type;
	const mono = mono_struct_name(type, table);
	if (mono === type.name) return type;
	const resolved = new Type(mono, type.is_static, type.is_array, type.length);
	resolved.storage_kind = type.storage_kind;
	resolved.is_ref = type.is_ref;
	resolved.is_const_ref = type.is_const_ref;
	resolved.is_nullable = type.is_nullable;
	return resolved;
}
