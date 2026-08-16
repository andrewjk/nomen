import type StructNode from "../nodes/StructNode.ts";
import type TraitNode from "../nodes/TraitNode.ts";
import type Type from "../nodes/Type.ts";

/**
 * The type tables a param classification needs: the (generic +
 * monomorphized) struct table and the trait table. Both backends'
 * BuildStatus satisfy this shape.
 */
export interface TypeTable {
	structs: StructNode[];
	traits: TraitNode[];
}

export interface ParamClassifyFlags {
	/** The param carries `ref` (node- or type-level). */
	is_ref?: boolean;
	/** The param is a method receiver (`self`). */
	is_self?: boolean;
	/** The param's declaration keyword (`const` / `var` / …). */
	declaration?: string;
}

export interface ParamClass {
	/** The non-simple struct registered under the (already resolved) name. */
	struct: StructNode | undefined;
	/** The trait registered under the name, if any. */
	trait: TraitNode | undefined;
	/** Passed by struct reference — emitted in `struct Tag` form. */
	is_struct: boolean;
	/** The resolved name is a simple (primitive-like) struct. */
	is_simple: boolean;
	/** The resolved name is a class (heap reference type). */
	is_class: boolean;
	/**
	 * A `ref` CLASS param is a double pointer (`struct T **` on C; a saved
	 * &slot on aarch64): the call site passes the address of the caller's
	 * pointer slot so the callee can reassign it (write-back).
	 */
	is_ref_class: boolean;
	/**
	 * The value arrives as a pointer: struct/trait reference, `ref` borrow,
	 * array data pointer, or a by-value `var` of struct type.
	 */
	wants_pointer: boolean;
}

/**
 * Classify how a parameter of the given (already backend-resolved) type
 * name is passed. The single source of the struct-vs-primitive,
 * pointer-count, and class-reference decisions shared by every C emission
 * site (free-function params, struct-method params, synthesized-constructor
 * params). The name resolution that PRECEDES this — self-param substitution,
 * heap `Array<T>` promotion, generic → monomorphized rewriting — is
 * per-call-site (each has its own context); this function starts from the
 * final name.
 */
export function classify_param(
	type: Type,
	type_name: string,
	flags: ParamClassifyFlags,
	table: TypeTable,
): ParamClass {
	const struct = table.structs.find((s) => s.name === type_name);
	const trait = table.traits.find((t) => t.name === type_name);
	// A self param is struct-passed unless the struct is simple; a plain
	// struct/trait param likewise. (For a simple struct the value is
	// primitive-like — `c_type` spelling, no struct tag.)
	const is_struct = (!!flags.is_self || !!struct || !!trait) && !struct?.is_simple_type;
	const is_simple = !!struct?.is_simple_type;
	const is_class = !!struct?.is_class;
	// Pointer rules:
	//   - struct / trait params: by reference
	//   - `ref` / array params: by pointer (modifications propagate)
	//   - `mov` on a SIMPLE type is by-value (the parser normalizes mov to
	//     var+is_moved; for simple types that pointer is meaningless)
	//   - `var` on a SIMPLE type is by-value too: the callee gets a mutable
	//     local copy. Modifying it does not propagate to the caller (the
	//     `ref` keyword is used for pass-by-reference).
	const wants_pointer =
		is_struct ||
		!!trait ||
		!!flags.is_ref ||
		type.is_array ||
		(!is_simple && flags.declaration === "var");
	const is_ref_class = !!flags.is_ref && is_class && !flags.is_self;
	return { struct, trait, is_struct, is_simple, is_class, is_ref_class, wants_pointer };
}
