import Type from "../../nodes/Type.ts";

/**
 * Row types of nested arrays (docs/ARRAY_NESTED_MONO.md). Monomorphizing
 * `Array` on a row (`Array<Array<int>>`) flattens the row arg to its mono
 * name (`Array_int`), and substitution is name-based — so the name alone
 * would turn every `T` in the mono body into the `Array_int` STRUCT value.
 * The registry maps each such name back to the heap-array type it stands
 * for, so substitution yields a real array type (an 8-byte buffer
 * pointer) and raw blocks see a pointer element.
 */
const ROW_TYPES = new Map<string, Type>();

/** Record `mono_name` (`Array_int`, `Array_Array_int`) as the row type
 *  `row` (`int` heap array, `int[][]` …). */
export function register_array_row(mono_name: string, row: Type): void {
	if (!ROW_TYPES.has(mono_name)) ROW_TYPES.set(mono_name, row);
}

/** The heap-array type a row mono name stands for, if it is one. */
export function array_row_type(name: string | undefined): Type | undefined {
	return name ? ROW_TYPES.get(name) : undefined;
}

/** Build the heap-array `Type` for an `Array<…>` generic spelling
 *  (`Array<Array<int>>` → `int` heap array with an `int` heap-array elem). */
export function heap_array_type_of(generic: Type): Type {
	const arg = generic.type_args![0];
	if (arg.name === "Array" && arg.type_args?.length === 1) {
		const inner = heap_array_type_of(arg);
		const t = new Type(inner.name);
		t.storage_kind = "heap_array";
		t.elem = inner;
		return t;
	}
	const t = new Type(arg.name);
	t.type_args = arg.type_args;
	t.storage_kind = "heap_array";
	return t;
}
