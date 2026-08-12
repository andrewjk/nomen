import type StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * The monomorphized `Array<T>` struct name for an array-typed value whose
 * element type is `type.name` (e.g. `Array_int`), or `undefined` when `type`
 * is not a heap `Array<T>` struct.
 *
 * Background. `Array<T>` is parse-rewritten to `{name: T, is_array: true,
 * is_array_heap: true}` (see parse_type) — the `is_array_heap` flag
 * DISTINGUISHES it deterministically from a raw `T[]` / `T[N]` stack array and
 * from an array-literal VALUE (both plain `is_array`). So this helper returns
 * the mono `Array_<elem>` struct IFF the type carries the heap flag; it no
 * longer falls back on "does the mono struct happen to exist?" (that
 * order-dependent gate was the old approach). The mono struct itself is
 * materialized at check time whenever an `Array<T>` annotation appears (see
 * `instantiate_generic_type`), so `status.structs` always holds it.
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
	if (!type || !type.is_array || !type.is_array_heap || type.is_view) return undefined;
	const mono = `Array_${type.name}`;
	const struct = status.structs.find((s) => s.name === mono && !s.is_generic) as
		| StructNode
		| undefined;
	return struct ? mono : undefined;
}
