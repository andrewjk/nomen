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
	/** Semantic width in bits. Ints only; float widths live with the ABIs. */
	bits?: number;
}

const TYPE_INFO: BuiltInTypeInfo[] = [
	// True or false
	{ name: "bool", kind: "bool", signed: false },
	// Alias to 32 bit int
	{ name: "int", kind: "int", signed: true, bits: 32 },
	{ name: "uint", kind: "int", signed: false, bits: 32 },
	// Sized ints
	{ name: "int8", kind: "int", signed: true, bits: 8 },
	{ name: "uint8", kind: "int", signed: false, bits: 8 },
	{ name: "int16", kind: "int", signed: true, bits: 16 },
	{ name: "uint16", kind: "int", signed: false, bits: 16 },
	{ name: "int32", kind: "int", signed: true, bits: 32 },
	{ name: "uint32", kind: "int", signed: false, bits: 32 },
	{ name: "int64", kind: "int", signed: true, bits: 64 },
	{ name: "uint64", kind: "int", signed: false, bits: 64 },
	// Alias to 32 bit float
	{ name: "float", kind: "float", signed: true },
	{ name: "ufloat", kind: "float", signed: false },
	// Sized floats
	{ name: "float32", kind: "float", signed: true },
	{ name: "ufloat32", kind: "float", signed: false },
	{ name: "float64", kind: "float", signed: true },
	{ name: "ufloat64", kind: "float", signed: false },
	// Char -- a unicode point
	{ name: "char", kind: "char", signed: false },
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

/** Signed floats. Unsigned floats (`ufloat*`) take no float conversion or
 *  cast path yet. */
export const SIGNED_FLOAT_TYPES = ["float", "float32", "float64"];

/** All floats including unsigned ones — the full float register model. */
export const ALL_FLOAT_TYPES = ["float", "ufloat", "float32", "ufloat32", "float64", "ufloat64"];

/** Every numeric scalar plus bool/char: values that live in a single
 *  register pair (x regs) or FP register (d regs). Used by loop codegen to
 *  decide which callee-saved registers to preserve. */
export const SCALAR_TYPES = [...ALL_INT_TYPES, ...ALL_FLOAT_TYPES, "bool", "char"];

/** Scalar types accepted as file-scope `const` initializers and as
 *  auto-inline param/return types. Same as SCALAR_TYPES minus unsigned
 *  floats, which neither backend's const-data emitter handles yet. */
export const SIMPLE_TYPES = [...INT_TYPES, ...SIGNED_FLOAT_TYPES, "bool", "char"];

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
