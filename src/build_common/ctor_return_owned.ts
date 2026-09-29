import type BaseNode from "../nodes/BaseNode.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import { direct_string_fields } from "./has_string_fields.ts";
import tuple_return_owned_element from "./tuple_return_owned_element.ts";

/**
 * For a struct-constructor RETURN (`return R(a, b)`), the set of direct string
 * field names whose constructor argument ALREADY owns heap and can therefore
 * stay raw (no return-boundary strdup). Every other string field is strdup'd
 * by the return so a caller binding the result can uniformly own and free
 * every string field.
 *
 * The auto-constructor's parameters are the struct's non-defaulted fields in
 * declaration order. A field with a default has no argument (its default was
 * seeded by the constructor and must be copied). An argument that is a
 * transferred owning value (`tuple_return_owned_element`) transfers raw.
 */
export default function ctor_return_owned_string_fields(
	return_struct: StructNode,
	call: FunctionCallNode,
	heap_strings: Set<string> | undefined,
): Set<string> {
	const skip = new Set<string>();
	const required = return_struct.fields.filter((f) => f.value == null);
	for (const field of direct_string_fields(return_struct)) {
		const idx = required.findIndex((f) => f.name === field.name);
		if (idx < 0) continue; // defaulted field — always copied
		const arg = call.params[idx] as BaseNode | undefined;
		if (arg && tuple_return_owned_element(arg, heap_strings)) skip.add(field.name);
	}
	return skip;
}
