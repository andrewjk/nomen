import add_error from "../add_error.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import hoist_struct_params from "./utils/hoist_struct_params.ts";
import { is_owning_struct_type } from "./utils/ownership.ts";
import {
	is_trait_type,
	is_value_struct_conformer,
	value_struct_trait_error,
} from "./utils/trait_slot.ts";
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
/**
 * Tuple-element ownership resolution. A bare owning-struct variable element
 * (`[t, c]` where t is a `List<string>`) byte-copies the struct — the
 * tuple's field would alias the local's buffer, and both cleanups free it
 * (double-free). Three outcomes per element:
 *
 *   - explicit `move t` — transfer (registered like the move-assignment
 *     path; the tuple's field cleanup owns the buffer now);
 *   - plain `t` stamped by the literal last-use pass — INFERRED transfer
 *     (t is provably never read again, so copy-then-drop and move are
 *     observationally identical; the move is free);
 *   - plain `t` still referenced later — rejected, exactly like the
 *     declaration-path owning-struct copy rule: transfer with `move` or
 *     deep-copy with `.copy()`.
 *
 * Strings and non-owning structs are ordinary by-value copies (views).
 */
function check_tuple_element_ownership(array: ArrayValuesNode, status: CheckStatus): boolean {
	let rejected = false;
	for (const value of array.values) {
		const vn = value as ValueNode;
		if (vn.node_type !== "value") continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(vn.value) || vn.value === "null") continue;
		const t = type_from_value_node(value, status);
		if (!t.name) continue;
		if (is_owning_struct_type(t, status)) {
			if (vn.is_moved || vn.literal_last_use_move) {
				// Ownership transfers to the tuple: the source's cleanup must
				// skip it (use-after-move on later reads is checked separately).
				vn.is_moved = true;
				if (!status.moved_variables) status.moved_variables = new Set();
				status.moved_variables.add(vn.value);
			} else {
				add_error(
					status,
					`cannot copy '${t.name}' by value — it owns heap resources; use 'move ${vn.value}' or '${vn.value}.copy()'`,
					value.start,
				);
				rejected = true;
			}
			continue;
		}
		// A string local is in the same boat as an owning struct: the tuple
		// field aliases its buffer, and the callee's scope-exit free would
		// leave the returned tuple reading freed memory (masked — the freed
		// block usually still holds the bytes). At the variable's last use
		// the transfer is inferred; read again later, it is rejected (the
		// caller would read freed memory). Static (rodata-derived) strings
		// transfer too: on C the local is a heap strdup, on aarch64 it is
		// static storage — the backends' binding emitters handle each.
		if (t.name === "string" && !t.is_view && !t.is_array) {
			if (vn.is_moved || vn.literal_last_use_move) {
				// Transfer: the callee's cleanup must skip the local (the
				// tuple's field now owns the buffer) and the receiving
				// binding takes it over (see the destructuring build).
				vn.is_moved = true;
				if (!status.moved_variables) status.moved_variables = new Set();
				status.moved_variables.add(vn.value);
			} else {
				add_error(
					status,
					`string local '${vn.value}' is read again after the literal — use 'move ${vn.value}' or '${vn.value}.to_string()'`,
					value.start,
				);
				rejected = true;
			}
		}
	}
	return rejected;
}

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

	if (check_tuple_element_ownership(array, status)) result = false;

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
	(target as any).move_param_indices = source.move_param_indices;
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
		// Detect heterogeneity (skip "null" values, which are ambiguous).
		// Generic instances differing only in type_args (`List<string>` vs
		// `List<int>`) are DIFFERENT types — an array of the first would
		// silently mistype the rest — so they tuple-ize like any other
		// heterogeneous literal.
		const meaningful = value_types.filter((t) => t.name && t.name !== "null");
		const first_meaningful = meaningful[0];
		const same_generic_shape = (a: Type, b: Type): boolean => {
			if (a.name !== b.name) return false;
			const aa = a.type_args ?? [];
			const bb = b.type_args ?? [];
			return (
				aa.length === bb.length &&
				aa.every((t, i) => t.name === bb[i]?.name) &&
				!a.tuple_types?.length &&
				!b.tuple_types?.length
			);
		};
		const all_same =
			meaningful.length > 0 && meaningful.every((t) => same_generic_shape(t, first_meaningful));

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

			if (check_tuple_element_ownership(array, status)) result = false;

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
		// Two-tier trait rule: a trait-typed COLLECTION element slot holds
		// the pointer representation (a heap instance with a vtable header).
		// A value-struct conformer has no header and cannot cross into the
		// container — reject it here (the trait-typed LOCAL exception does
		// not apply: this slot outlives inline storage assumptions).
		if (is_trait_type(array_item_type.name, status)) {
			const conformer = is_value_struct_conformer(vt.name, array_item_type.name!, status)
				? vt.name!
				: undefined;
			if (conformer) {
				add_error(status, value_struct_trait_error(conformer, array_item_type.name!), value.start);
				continue;
			}
		}
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
