import BaseNode from "./BaseNode.ts";

/**
 * The storage form of a `Type`, encoding what was previously three
 * independent booleans (`is_array`, `is_array_heap`, `is_view`) as a single
 * mutually-exclusive discriminant. The legacy booleans are exposed below as
 * getter/setter pairs that all read and write this field, so an inconsistent
 * combination like `is_array && is_array_heap && is_view` is no longer
 * representable — every code path that observes one of them sees a value
 * consistent with the others.
 *
 *   - `stack_array` — a raw `T[]`/`T[N]` stack C array, or an array-literal
 *     VALUE. Was `is_array && !is_array_heap && !is_view`.
 *   - `heap_array` — the generic heap `Array<T>` struct (parse-rewritten from
 *     `Array<T>` to `{name: T, storage_kind: "heap_array"}`). Lowers to a
 *     heap `struct Array_<T>*` (header + inline data). Was
 *     `is_array && is_array_heap && !is_view`.
 *   - `view` — a non-owning, non-escaping borrow view of a container's
 *     contents (e.g. `view string` = a (ptr, len) slice into a string's
 *     buffer, `view T` into a `List<T>`/`Buffer<T>`). Was `is_view` with no
 *     array flag.
 *   - `undefined` — a plain value/reference type.
 *
 * See FOLLOWUP.md "Array storage kind" for the history.
 */
export type StorageKind = "stack_array" | "heap_array" | "view";

export default class Type {
	name: string;
	is_static?: boolean;
	storage_kind?: StorageKind;
	is_ref?: boolean;
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

	/**
	 * True when this type is an array (stack or heap). Reads from
	 * `storage_kind`. Setting `is_array = true` promotes a plain type to a
	 * `stack_array` (or leaves a `heap_array` as heap). Setting it to a
	 * falsy value demotes any array form back to a plain type.
	 */
	get is_array(): boolean | undefined {
		return this.storage_kind === "stack_array" || this.storage_kind === "heap_array"
			? true
			: undefined;
	}
	set is_array(v: boolean | undefined) {
		if (v) {
			if (this.storage_kind !== "heap_array") this.storage_kind = "stack_array";
		} else {
			if (this.storage_kind === "stack_array" || this.storage_kind === "heap_array") {
				this.storage_kind = undefined;
			}
		}
	}

	/**
	 * True when `is_array` denotes the generic heap `Array<T>` struct, as
	 * opposed to a raw `T[]`/`T[N]` stack array or an array-literal VALUE.
	 * Reads from `storage_kind`. Setting `is_array_heap = true` makes the
	 * type a `heap_array`; setting it falsy while an array demotes it to a
	 * `stack_array`.
	 */
	get is_array_heap(): boolean | undefined {
		return this.storage_kind === "heap_array" ? true : undefined;
	}
	set is_array_heap(v: boolean | undefined) {
		if (v) {
			this.storage_kind = "heap_array";
		} else {
			if (this.storage_kind === "heap_array") this.storage_kind = "stack_array";
		}
	}

	/**
	 * A non-owning, non-escaping borrow view of a container's contents
	 * (e.g. `view string` = a (ptr, len) slice into a string's buffer).
	 * Views are not auto-freed (they own no heap) and may not escape the
	 * scope of their source — enforced by the existing borrow machinery.
	 * Reads from `storage_kind`. Setting `is_view = true` makes the type a
	 * `view` (clearing any array form, since views own nothing); setting it
	 * falsy clears the view kind.
	 */
	get is_view(): boolean | undefined {
		return this.storage_kind === "view" ? true : undefined;
	}
	set is_view(v: boolean | undefined) {
		if (v) {
			this.storage_kind = "view";
		} else {
			if (this.storage_kind === "view") this.storage_kind = undefined;
		}
	}

	constructor(name: string, is_static?: boolean, is_array?: boolean, length?: BaseNode) {
		this.name = name;
		this.is_static = is_static;
		this.is_array = is_array;
		this.length = length;
	}
}
