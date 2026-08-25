/**
 * Single source of truth for the built-in type names and their
 * classification. Every predicate that keys off a built-in type's name —
 * value type, signedness, hashability, negatability, sendability, cast
 * rules, register models — should be derived from this module rather than
 * hand-maintained name lists scattered across check/ and the backends.
 *
 * This module must stay import-free: parse, check, and both build backends
 * all depend on it.
 */

export interface BuiltInTypeInfo {
	name: string;
	/** Coarse category most classifications derive from. */
	kind: "bool" | "int" | "float" | "char" | "string" | "func";
	/**
	 * Arithmetic signedness: signed ints and floats are true; `uint*` /
	 * `ufloat*`, bool, char, string, and func are false. Drives
	 * sign-extending loads (floats load through the signed ladder) but NOT
	 * unary minus — `uint` is negatable even though it is unsigned (it
	 * wraps), see `is_negatable_type`.
	 */
	signed: boolean;
	/** Value range in bits, used for literal validation (ints only). */
	bits?: number;
	/**
	 * Storage width in bytes, shared by both backends' layouts. Note that
	 * storage is wider than range for some types (`int`/`uint` occupy 8
	 * bytes — C `long` / a full register — while literals validate against
	 * 32-bit ranges), so both columns must stay independent.
	 */
	bytes?: number;
	/**
	 * The C type this name lowers to. Single source of truth for every C
	 * emission path (declarations/fields via c_type(), raw-block T
	 * substitution) so layout and bodies can never disagree on width or
	 * signedness.
	 */
	c_type?: string;
}

const TYPE_INFO: BuiltInTypeInfo[] = [
	// True or false
	{ name: "bool", kind: "bool", signed: false, bytes: 1, c_type: "unsigned char" },
	// Alias to a 32-bit-range int stored in a full word (C long)
	{ name: "int", kind: "int", signed: true, bits: 32, bytes: 8, c_type: "long" },
	{ name: "uint", kind: "int", signed: false, bits: 32, bytes: 8, c_type: "unsigned long" },
	// Sized ints
	{ name: "int8", kind: "int", signed: true, bits: 8, bytes: 1, c_type: "char" },
	{ name: "uint8", kind: "int", signed: false, bits: 8, bytes: 1, c_type: "unsigned char" },
	{ name: "int16", kind: "int", signed: true, bits: 16, bytes: 2, c_type: "short" },
	{ name: "uint16", kind: "int", signed: false, bits: 16, bytes: 2, c_type: "unsigned short" },
	{ name: "int32", kind: "int", signed: true, bits: 32, bytes: 4, c_type: "int" },
	{ name: "uint32", kind: "int", signed: false, bits: 32, bytes: 4, c_type: "unsigned int" },
	{ name: "int64", kind: "int", signed: true, bits: 64, bytes: 8, c_type: "long long" },
	{
		name: "uint64",
		kind: "int",
		signed: false,
		bits: 64,
		bytes: 8,
		c_type: "unsigned long long",
	},
	// Floats: all widths share 8-byte double storage/ABI on supported targets
	{ name: "float", kind: "float", signed: true, bytes: 8, c_type: "double" },
	{ name: "ufloat", kind: "float", signed: false, bytes: 8, c_type: "double" },
	{ name: "float32", kind: "float", signed: true, bytes: 8, c_type: "double" },
	{ name: "ufloat32", kind: "float", signed: false, bytes: 8, c_type: "double" },
	{ name: "float64", kind: "float", signed: true, bytes: 8, c_type: "double" },
	{ name: "ufloat64", kind: "float", signed: false, bytes: 8, c_type: "double" },
	// Char -- an unsigned 8-bit code point
	{ name: "char", kind: "char", signed: false, bytes: 1, c_type: "unsigned char" },
	// String -- type depends on how it's defined
	// E.g. const string = "hello" is static
	//      const string = "hello, \{name}" is fixed size and on the stack
	//      var string = "hello" is on the heap
	{ name: "string", kind: "string", signed: false },
	// Function type
	{ name: "func", kind: "func", signed: false },
];

const names = TYPE_INFO.map((t) => t.name);

/** All built-in type names (e.g. seeds the checker's type namespace). */
const built_in_types = names;
export default built_in_types;

export function get_built_in_type(name: string): BuiltInTypeInfo | undefined {
	return TYPE_INFO.find((t) => t.name === name);
}

/** The C type a built-in name lowers to, or undefined for non-built-ins /
 *  dynamically-mapped names (string/func/void/null keep backend-specific
 *  handling). Shared by every C emission path so layout and raw bodies
 *  always agree. */
export function built_in_c_type(name: string): string | undefined {
	return get_built_in_type(name)?.c_type;
}

export function is_built_in_type(name: string): boolean {
	return names.includes(name);
}

// --- Shared groupings -----------------------------------------------------
// INT_TYPES/UINT_TYPES order IS LOAD-BEARING: implicit int coercion ranks
// types by index (`int` ranks between `int32` and `int64`). Do not reorder
// without checking the literal-coercion tests.

export const INT_TYPES = ["int8", "int16", "int32", "int", "int64"];
export const UINT_TYPES = ["uint8", "uint16", "uint32", "uint", "uint64"];
export const ALL_INT_TYPES = [...INT_TYPES, ...UINT_TYPES];

/** Signed floats. `can_implicit_cast` only widens ints into signed floats. */
export const SIGNED_FLOAT_TYPES = ["float", "float32", "float64"];

/** All floats including unsigned ones — the full float register model. */
export const ALL_FLOAT_TYPES = ["float", "ufloat", "float32", "ufloat32", "float64", "ufloat64"];

/** Every numeric scalar plus bool/char: values that live in a single
 *  register pair (x regs) or FP register (d regs). Used by loop codegen to
 *  decide which callee-saved registers to preserve. */
export const SCALAR_TYPES = [...ALL_INT_TYPES, ...ALL_FLOAT_TYPES, "bool", "char"];

/** Scalar types accepted as file-scope `const` initializers and as
 *  auto-inline param/return types: every numeric scalar plus bool/char. */
export const SIMPLE_TYPES = [...ALL_INT_TYPES, ...ALL_FLOAT_TYPES, "bool", "char"];

// --- Predicates -----------------------------------------------------------

export function is_int_type(name: string): boolean {
	return get_built_in_type(name)?.kind === "int";
}

export function is_signed_int_type(name: string): boolean {
	const info = get_built_in_type(name);
	return info?.kind === "int" && info.signed;
}

export function is_unsigned_int_type(name: string): boolean {
	const info = get_built_in_type(name);
	return info?.kind === "int" && !info.signed;
}

/** Any float, including unsigned variants. */
export function is_float_type(name: string): boolean {
	return get_built_in_type(name)?.kind === "float";
}

export function is_signed_float_type(name: string): boolean {
	return SIGNED_FLOAT_TYPES.includes(name);
}

/** Numeric scalars (ints + floats) plus bool and char. */
export function is_scalar_type(name: string): boolean {
	return SCALAR_TYPES.includes(name);
}

/**
 * Scalars whose values can cast to `uint` for hashing: ints, bool, char.
 * Floats and string are deliberately excluded — there is no builtin hash
 * for them, so e.g. a struct with a string field gets no auto-derived
 * `hash`.
 */
export function is_hashable_scalar(name: string): boolean {
	return is_int_type(name) || name === "bool" || name === "char";
}

/**
 * Unary minus is allowed: every int (unsigned wraps) and every signed
 * float.
 */
export function is_negatable_type(name: string): boolean {
	return is_int_type(name) || is_signed_float_type(name);
}

/** Signed per the metadata flag: signed ints and signed floats. Matches the
 *  sign-extending load ladders in the aarch64 backend. */
export function is_signed_type(name: string): boolean {
	return get_built_in_type(name)?.signed === true;
}

/** Width of an int in bits; 0 for anything that isn't a sized int. */
export function type_bits(name: string): number {
	const info = get_built_in_type(name);
	return info?.kind === "int" ? (info.bits ?? 0) : 0;
}
