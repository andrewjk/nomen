import type CheckStatus from "../CheckStatus.ts";

/**
 * Trait-object representation (STRUCT_PLAN_3 B4).
 *
 * A trait-typed position — local, parameter, field, container element,
 * return — holds a boxed handle: a heap instance whose first word is the
 * conformer's vtable. A value-struct conformer boxes implicitly; the trait
 * annotation is the marker (T1). Boxing takes ownership (T2): boxing a bare
 * local is a move (the donor is invalidated), boxing a fresh temporary is
 * free, and borrows/views cannot be boxed. Class conformers box by pointer —
 * the instance is already heap (T4, transition era until Phase R).
 *
 * The former tier-1 inline-local representation is retired: both backends
 * emit handles at every trait position, and the only zero-malloc site left
 * is the bare-parameter calling convention (T3: the caller passes a pointer
 * to a stack copy for the duration of the call).
 */

/** Whether `name` is a declared trait. */
export function is_trait_type(name: string | undefined, status: CheckStatus): boolean {
	return !!name && status.traits.some((t) => t.name === name);
}

/** Whether `name` is a declared VALUE struct (non-class, non-simple). */
export function is_value_struct(name: string | undefined, status: CheckStatus): boolean {
	if (!name) return false;
	const s = status.structs.find((st) => st.name === name);
	return !!s && !s.is_class && !s.is_simple_type;
}

/** Whether the value struct `struct_name` conforms to the trait `trait_name`. */
export function conforms_to_trait(
	struct_name: string,
	trait_name: string,
	status: CheckStatus,
): boolean {
	const s = status.structs.find((st) => st.name === struct_name);
	return !!s && s.traits.includes(trait_name);
}

/** Whether `struct_name` is a value struct that conforms to `trait_name`. */
export function is_value_struct_conformer(
	struct_name: string | undefined,
	trait_name: string,
	status: CheckStatus,
): boolean {
	return (
		!!struct_name &&
		struct_name !== trait_name &&
		is_value_struct(struct_name, status) &&
		conforms_to_trait(struct_name, trait_name, status)
	);
}

/** The one error wording for boxing a value that has no owner to give (T2). */
export function boxing_owns_error(): string {
	return `boxing owns its instance — move the value, or copy it ('.copy()')`;
}
