import { array_row_type } from "../check/utils/array_row_types.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type StructNode from "../nodes/StructNode.ts";

/**
 * The value struct whose own `copy()` deep-copies an `Array<T>` element of
 * type `name`, or undefined when the element byte-copies. Only a zero-arg
 * `copy(self)` counts (the synthesized one or a user method of that shape).
 * `Array.copy()` calls it per element (`T_HAS_COPY` / `T_copy` in the
 * library body, and the backends' inline nested-row copies).
 */
export function element_copy_struct(
	name: string | undefined,
	structs: StructNode[],
): StructNode | undefined {
	if (!name) return undefined;
	// A nested array's row (`Array_Rec` in `Array_Array_Rec`) is a buffer
	// pointer; its copy ABI differs from a value struct's (row-T copy is
	// docs/ARRAY_NESTED_MONO.md step 2 — nested `copy()` lowers inline).
	if (array_row_type(name)) return undefined;
	const st = structs.find(
		(s) => s.name === name && !s.is_class && !s.is_simple_type && !s.is_generic,
	);
	if (!st) return undefined;
	const copy = st.functions.find(
		(f) => f.name === "copy" && f.params.filter((p) => !p.is_self_param).length === 0,
	);
	return copy ? st : undefined;
}

/** True for `xs.copy()` — or `xs.add(ys)` / `xs.mul(n)`, which `+` / `*`
 *  lower to — on a heap `Array<T>`: the result owns its elements (fresh
 *  strings, rows, and struct copies), so its cleanup destroys them like a
 *  literal-built array's. */
export function is_array_copy_call(node: BaseNode | undefined): boolean {
	if (!node || node.node_type !== "access") return false;
	const af = (node as AccessNode).access;
	if (af.node_type !== "access_func") return false;
	const call = af as AccessFunctionCallNode;
	// The library mono's lowered signature returns a `T` array (its
	// `out Array<T>`), which tells it apart from another type's `copy`.
	const arity = call.name === "copy" ? 0 : call.name === "add" || call.name === "mul" ? 1 : -1;
	return (
		call.params.length === arity &&
		!!call.type?.is_array &&
		!!call.resolved_function?.return_type?.is_array
	);
}
