import type BaseNode from "../nodes/BaseNode.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import { direct_string_fields } from "./has_string_fields.ts";
import { is_string_borrow } from "./string_return_analysis.ts";
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

/**
 * The overridden string fields whose CONSTRUCTOR-SEEDED value owns heap and
 * is therefore displaced un-freed by a raw override store: a non-literal
 * default expression (the auto-constructor evaluates it fresh per
 * construction — `var string a = "de" + "fault"` allocates) is owned by the
 * constructed struct alone, so an override replacing the field orphans the
 * buffer unless it is reclaimed ahead of the store. Literal defaults are
 * rodata (never freed) and value-node defaults are consts/borrows (not
 * owned); a custom `#init`'s `self.<field> = <param>` seeds alias the
 * caller's argument temps in the common case and are deliberately not
 * analyzed here.
 */
export function override_displaced_string_fields(
	struct_node: StructNode,
	overrides: { name: string; value: BaseNode }[] | undefined,
): string[] {
	if (!overrides?.length) return [];
	const displaced: string[] = [];
	for (const override of overrides) {
		const field = struct_node.fields.find((f) => f.name === override.name);
		if (!field) continue;
		if (field.type.name !== "string" || field.type.is_array || field.type.is_view) continue;
		const seed = field.value;
		if (!seed || seed.node_type === "value") continue;
		if (is_string_borrow(seed)) continue;
		displaced.push(override.name);
	}
	return displaced;
}

/**
 * The aarch64 counterpart of override_displaced_string_fields: the
 * overridden string fields whose ctor-seeded default is a non-literal
 * expression that produced a HEAP value. The extra `is_owned_heap` check
 * (the aarch64 is_owned_heap_temp) matters because the aarch64 backend does
 * NOT strdup every string return: a literal-returning user function leaves
 * RODATA in the seeded field, which must never be freed. Used at the
 * expression-temp override boundaries (no heap_string_fields records exist
 * there, so the stores stay raw and the seed needs an explicit reclaim).
 */
export function ctor_heap_displaced_string_fields(
	struct_node: StructNode,
	overrides: { name: string; value: BaseNode }[] | undefined,
	is_owned_heap: (seed: BaseNode) => boolean,
): string[] {
	if (!overrides?.length) return [];
	const displaced: string[] = [];
	for (const override of overrides) {
		const field = struct_node.fields.find((f) => f.name === override.name);
		if (!field) continue;
		if (field.type.name !== "string" || field.type.is_array || field.type.is_view) continue;
		const seed = field.value;
		if (!seed || seed.node_type === "value") continue;
		if (is_string_borrow(seed)) continue;
		if (!is_owned_heap(seed)) continue;
		displaced.push(override.name);
	}
	return displaced;
}
