import BaseNode from "./BaseNode.ts";

export default class Type {
	name: string;
	is_static?: boolean;
	is_array?: boolean;
	/**
	 * True when `is_array` denotes the generic heap `Array<T>` struct (parse-
	 * rewritten to `{name: T, is_array: true, is_array_heap: true}`), as
	 * opposed to a raw `T[]` / `T[N]` stack array or an array-literal VALUE.
	 * `Array<T>` lowers to a heap `struct Array_<T>*` (header + inline data);
	 * the raw forms are stack C arrays (`long x[3]`) / element pointers. This
	 * flag is the deterministic, source-level replacement for the old build-time
	 * "does the mono struct exist?" gate (see ROADBLOCKS `Array<T>.set`).
	 */
	is_array_heap?: boolean;
	is_ref?: boolean;
	/**
	 * A non-owning, non-escaping borrow view of a container's contents
	 * (e.g. `view string` = a (ptr, len) slice into a string's buffer).
	 * Views are not auto-freed (they own no heap) and may not escape the
	 * scope of their source — enforced by the existing borrow machinery.
	 */
	is_view?: boolean;
	/**
	 * True when this value is a read-only class reference obtained by
	 * extracting from a const source (e.g. `const_list.at(i)` where the
	 * element type is a class). Field writes through a const_ref are
	 * rejected, as are mutating (`ref self`) method dispatch and forwarding
	 * to a `ref`/`mov` parameter. To regain mutability: don't declare the
	 * source `const`, take a `ref` to the source first, or `.clone()` the
	 * element.
	 *
	 * Originated by the checker (never the parser) at the method-result
	 * chokepoint (`check_function_call.ts`), and propagated onto the
	 * declared type (`check_declaration_node.ts`) so it is infectious —
	 * you can't strip it by explicit annotation. Propagated through
	 * `clone_type` and `substitute_type`. Analogous to `is_view` (a
	 * non-owning borrow), but `is_const_ref` is about *mutability*, not
	 * ownership. See FOLLOWUP.md "Deep-const for collections".
	 */
	is_const_ref?: boolean;

	length?: BaseNode;
	is_return_type?: boolean;
	is_nullable?: boolean;
	type_args?: Type[];
	func_params?: import("./ParameterNode.ts").default[];
	func_return_type?: Type;
	/**
	 * For tuple types `[T1, T2, ...]`, the list of element types.
	 * When set, `name` is "tuple".
	 */
	tuple_types?: Type[];

	constructor(name: string, is_static?: boolean, is_array?: boolean, length?: BaseNode) {
		this.name = name;
		this.is_static = is_static;
		this.is_array = is_array;
		this.length = length;
	}
}
