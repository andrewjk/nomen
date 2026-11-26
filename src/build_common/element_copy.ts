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
	const st = structs.find(
		(s) => s.name === name && !s.is_class && !s.is_simple_type && !s.is_generic,
	);
	if (!st) return undefined;
	const copy = st.functions.find(
		(f) => f.name === "copy" && f.params.filter((p) => !p.is_self_param).length === 0,
	);
	return copy ? st : undefined;
}

/** True for `xs.copy()` on a heap `Array<T>`: the result owns its elements
 *  (fresh strings, rows, and struct copies), so its cleanup destroys them
 *  like a literal-built array's. */
export function is_array_copy_call(node: BaseNode | undefined): boolean {
	if (!node || node.node_type !== "access") return false;
	const af = (node as AccessNode).access;
	if (af.node_type !== "access_func") return false;
	const call = af as AccessFunctionCallNode;
	// The library mono's lowered signature returns a `T` array (its
	// `out Array<T>`), which tells it apart from another type's `copy`.
	return (
		call.name === "copy" &&
		call.params.length === 0 &&
		!!call.type?.is_array &&
		!!call.resolved_function?.return_type?.is_array
	);
}
