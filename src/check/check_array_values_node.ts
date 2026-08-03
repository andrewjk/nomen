import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import hoist_struct_params from "./utils/hoist_struct_params.ts";
import { get_or_create_tuple_struct, tuple_struct_name } from "./utils/tuple_struct.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_array_values_node(
	array: ArrayValuesNode,
	status: CheckStatus,
): boolean {
	// Detect whether the expected type is a tuple (either an unmaterialized
	// tuple type `[T1, T2]` or an already-materialized `_Tuple_...` struct).
	const expected = status.expected_type;

	// Case 1: expected is a tuple value type (not array) → this literal should
	// construct a single tuple of that shape.
	if (expected?.tuple_types?.length && !expected.is_array) {
		return check_as_tuple(array, expected.tuple_types, status);
	}
	if (expected?.name?.startsWith("_Tuple_") && !expected.is_array) {
		const struct = status.structs.findLast((s) => s.name === expected.name);
		if (struct) {
			return check_as_tuple(
				array,
				struct.fields.map((f) => f.type),
				status,
			);
		}
	}

	// Case 2: expected is an array of tuples (`_Tuple_...[]` or `[T1, T2][]`).
	// Each value must be a tuple; we materialize each one individually.
	if (expected?.is_array) {
		const elem_is_tuple =
			(expected.name?.startsWith("_Tuple_") && expected.name !== "tuple") ||
			(expected.name === "tuple" && !!expected.tuple_types?.length);
		if (elem_is_tuple) {
			let tuple_types: Type[] | null = null;
			if (expected.name === "tuple") {
				tuple_types = expected.tuple_types!;
			} else if (expected.name?.startsWith("_Tuple_")) {
				const struct = status.structs.findLast((s) => s.name === expected.name);
				if (struct) {
					tuple_types = struct.fields.map((f) => f.type);
				}
			}
			if (tuple_types) {
				// Set expected_type to a single tuple type for each value, but
				// mark it as an array so the outer array context is preserved.
				const elem_type = new Type(expected.name!);
				elem_type.tuple_types = tuple_types;
				return check_as_array_of_tuples(array, status, elem_type);
			}
		}
	}

	// Otherwise, this is either a regular array OR a heterogeneous tuple
	// inferred from value types. We need to check each value once, then decide.
	return check_as_array_or_inferred_tuple(array, status);
}

/**
 * Validate an array literal as a tuple value, given the tuple's element types.
 * On success, mutates `array` in-place into a FunctionCallNode that constructs
 * the appropriate auto-generated tuple struct.
 */
function check_as_tuple(
	array: ArrayValuesNode,
	tuple_element_types: Type[],
	status: CheckStatus,
): boolean {
	if (array.values.length !== tuple_element_types.length) {
		// Wrong arity — fall back to array checking to surface a clean mismatch
		return check_as_array_or_inferred_tuple(array, status, tuple_element_types);
	}

	let result = true;
	const value_types: Type[] = [];
	const old_expected = status.expected_type;
	for (let i = 0; i < array.values.length; i++) {
		const value = array.values[i];
		status.expected_type = tuple_element_types[i];
		if (!check_node(value, status)) {
			result = false;
			status.expected_type = old_expected;
			continue;
		}
		status.expected_type = old_expected;
		const vt = type_from_value_node(value, status);
		value_types.push(vt);
		check_type_and_value_match(
			tuple_element_types[i],
			vt,
			value_from_value_node(value),
			status,
			value.start,
			"tuple",
		);
	}

	const struct_name = tuple_struct_name(tuple_element_types);
	get_or_create_tuple_struct(tuple_element_types, status);

	const constructor = new FunctionCallNode(array.start, struct_name);
	constructor.params = array.values.slice();
	hoist_struct_params(constructor, status);
	const new_type = new Type(struct_name);
	new_type.tuple_types = tuple_element_types;
	constructor.type = new_type;
	replace_in_place(array, constructor);
	return result;
}

/**
 * Replace `target`'s own properties with those from `source` so any references
 * held by parents observe the new node type.
 */
function replace_in_place(target: ArrayValuesNode, source: FunctionCallNode) {
	(target as any).node_type = source.node_type;
	(target as any).name = source.name;
	(target as any).type = source.type;
	(target as any).params = source.params;
	(target as any).is_static = source.is_static;
	(target as any).type_args = source.type_args;
	(target as any).ref_param_indices = source.ref_param_indices;
	(target as any).mov_param_indices = source.mov_param_indices;
	(target as any).swap_params = source.swap_params;
	(target as any).variadic_param_name = source.variadic_param_name;
	(target as any).variadic_param_index = source.variadic_param_index;
}

/**
 * Validate an array literal where each element should be a tuple, given the
 * tuple's element type (`elem_type` is a single tuple type — not array).
 * Each value is materialized into a tuple constructor in place, and the
 * outer array's type is set to "array of <tuple struct>".
 */
function check_as_array_of_tuples(
	array: ArrayValuesNode,
	status: CheckStatus,
	elem_type: Type,
): boolean {
	const old_expected = status.expected_type;
	let result = true;
	for (let i = 0; i < array.values.length; i++) {
		const value = array.values[i];
		// For nested array literals, set expected to the tuple element type so
		// they get converted into tuple constructor calls.
		status.expected_type = elem_type;
		if (!check_node(value, status)) {
			result = false;
		}
	}
	status.expected_type = old_expected;

	// Set the outer array type
	array.type = new Type(elem_type.name);
	array.type.is_array = true;
	array.type.tuple_types = elem_type.tuple_types;
	if (!array.type.length) {
		array.type.length = new ValueNode(-1, array.values.length.toString(), new Type("int"));
	}
	return result;
}

/**
 * Check `array` as a regular array, but first infer the type of each value to
 * detect whether the values are heterogeneous (in which case we transparently
 * build a tuple instead). This avoids checking any value twice.
 *
 * Heterogeneous inference only fires when there is no `expected_type` (e.g.
 * `var things = [1, "first"]`). When the caller specifies an array type, we
 * respect it and surface a normal element-type mismatch instead.
 */
function check_as_array_or_inferred_tuple(
	array: ArrayValuesNode,
	status: CheckStatus,
	forced_tuple_types?: Type[],
): boolean {
	const has_outer_expected =
		!!status.expected_type &&
		!!status.expected_type.name &&
		!status.expected_type.tuple_types?.length &&
		!status.expected_type.name?.startsWith("_Tuple_");

	const old_expected = status.expected_type;

	if (!has_outer_expected) {
		// Don't leak an outer (non-tuple) expected_type to individual values
		status.expected_type = undefined;
	}

	let result = true;
	const value_types: Type[] = [];
	for (let value of array.values) {
		if (!check_node(value, status)) {
			result = false;
			continue;
		}
		value_types.push(type_from_value_node(value, status));
	}

	status.expected_type = old_expected;

	if (forced_tuple_types) {
		// Caller asked for a tuple of this shape but arity mismatched — emit
		// element-wise errors using the expected types.
		for (let i = 0; i < array.values.length; i++) {
			const expected_type =
				i < forced_tuple_types.length ? forced_tuple_types[i] : forced_tuple_types.at(-1)!;
			check_type_and_value_match(
				expected_type,
				value_types[i],
				value_from_value_node(array.values[i]),
				status,
				array.values[i].start,
				"tuple",
			);
		}
		array.type = array.type.name ? array.type : new Type("int");
		array.type.is_array = true;
		if (!array.type.length) {
			array.type.length = new ValueNode(-1, array.values.length.toString(), new Type("int"));
		}
		return result;
	}

	// Only infer a tuple from heterogeneous values when there's no outer
	// expected array type — otherwise we'd silently accept mismatched arrays.
	if (!has_outer_expected) {
		// Detect heterogeneity (skip "null" values, which are ambiguous)
		const meaningful = value_types.filter((t) => t.name && t.name !== "null");
		const first_meaningful = meaningful[0];
		const all_same =
			meaningful.length > 0 &&
			meaningful.every(
				(t) =>
					t.name === first_meaningful.name &&
					!t.tuple_types?.length &&
					!first_meaningful.tuple_types?.length,
			);

		if (!all_same && array.values.length > 0) {
			const elem_types = value_types.map((t, _i) => {
				if (!t.name || t.name === "null") {
					return meaningful[0] || new Type("int");
				}
				return t;
			});

			for (let i = 0; i < value_types.length; i++) {
				check_type_and_value_match(
					elem_types[i],
					value_types[i],
					value_from_value_node(array.values[i]),
					status,
					array.values[i].start,
					"tuple",
				);
			}

			const struct_name = tuple_struct_name(elem_types);
			get_or_create_tuple_struct(elem_types, status);

			const constructor = new FunctionCallNode(array.start, struct_name);
			constructor.params = array.values.slice();
			hoist_struct_params(constructor, status);
			const new_type = new Type(struct_name);
			new_type.tuple_types = elem_types;
			constructor.type = new_type;
			replace_in_place(array, constructor);
			return result;
		}
	}

	// Homogeneous (or empty), or an outer array type was expected — handle as array
	let array_item_type: Type;
	if (old_expected?.is_array && old_expected.name) {
		// Outer expected array element type wins (e.g. `Array<int> x = ...`)
		array_item_type = new Type(old_expected.name);
		array.type = new Type(old_expected.name);
		array.type.is_array = true;
		array.type.is_nullable = old_expected.is_nullable;
		array.type.type_args = old_expected.type_args;
		array.type.length = old_expected.length;
	} else if (!array.type.name) {
		// Infer element type from first value
		const first_type = value_types[0];
		if (first_type) {
			array.type = new Type(first_type.name);
			array.type.is_array = true;
		}
		array_item_type = new Type(array.type.name);
	} else {
		array_item_type = new Type(array.type.name);
	}

	for (let i = 0; i < value_types.length; i++) {
		const value = array.values[i];
		const vt = value_types[i];
		if (!vt) continue;
		check_type_and_value_match(
			array_item_type,
			vt,
			value_from_value_node(value),
			status,
			value.start,
			"array",
		);
	}

	if (!array.type.length) {
		array.type.length = new ValueNode(-1, array.values.length.toString(), new Type("int"));
	}
	array.type.is_array = true;

	return result;
}
