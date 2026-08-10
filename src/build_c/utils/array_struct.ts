import type StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * The monomorphized `Array<T>` struct name for an array-typed value whose
 * element type is `type.name` (e.g. `Array_int`), or `undefined` when `type`
 * is not a heap `Array<T>` struct.
 *
 * Background. `Array<T>` is rewritten to `{ name: T, is_array: true }` at
 * parse time (see parse_type), which erases the distinction between an
 * `Array<T>` struct (header + inline data) and a raw `T[]` / `T[N]` stack
 * array. The backends recover the distinction by consulting the
 * monomorphized struct table: an `is_array` type with NO compile-time
 * `length`, whose `Array_<elem>` mono struct exists, is a heap `Array<T>`
 * struct pointer. Everything else bearing `is_array` (a length-annotated
 * stack array, a variadic param's `T*`, a `view` slice) is raw.
 *
 * Use this to gate the struct-pointer code paths (parameter emission,
 * `.length`/`.at`/`.set` dispatch, call-site argument passing) so an
 * `Array<T>` is treated like the generic struct it is, rather than a raw
 * element pointer.
 */
export default function array_struct_name(
	type: Type | undefined,
	status: BuildStatus,
): string | undefined {
	if (!type || !type.is_array || type.length || type.is_view) return undefined;
	const mono = `Array_${type.name}`;
	const struct = status.structs.find((s) => s.name === mono && !s.is_generic) as
		| StructNode
		| undefined;
	return struct ? mono : undefined;
}
