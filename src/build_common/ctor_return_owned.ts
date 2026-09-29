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

/** The OVERRIDE value of a string field, when the field is overridden. */
function override_value_for_field(
	overrides: { name: string; value: BaseNode }[] | undefined,
	field_name: string,
): BaseNode | undefined {
	return overrides?.find((o) => o.name === field_name)?.value;
}

/**
 * The skip set for an OVERRIDE return (`return [ .. <base>, f = v, ... ]` in
 * its checked forms: a ctor call with `field_overrides`, or a base-bearing
 * anonymous struct literal). The overrides were applied to the return temp
 * BEFORE this analysis runs, so an overridden field holds the OVERRIDE
 * value's pair: it stays raw only when that value owns heap (a transferred
 * heap local, a fresh non-borrow expression). A non-overridden field keeps
 * the base's value: with `base_uniformly_owned` (a forwarded registered
 * normalizing base) it transfers raw; otherwise it follows `base_skip` (the
 * plain constructor-argument ownership analysis).
 */
export function override_return_string_fields(
	return_struct: StructNode,
	overrides: { name: string; value: BaseNode }[] | undefined,
	heap_strings: Set<string> | undefined,
	opts: { base_skip?: Set<string>; base_uniformly_owned?: boolean },
): Set<string> {
	const skip = new Set<string>();
	for (const field of direct_string_fields(return_struct)) {
		const override = override_value_for_field(overrides, field.name);
		if (override) {
			if (tuple_return_owned_element(override, heap_strings)) skip.add(field.name);
		} else if (opts.base_uniformly_owned || opts.base_skip?.has(field.name)) {
			skip.add(field.name);
		}
	}
	return skip;
}
