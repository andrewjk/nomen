import add_error from "../add_error.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { instantiate_generic_type } from "./check_function_call_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import hoist_struct_params from "./utils/hoist_struct_params.ts";
import {
	borrowed_param_transfer_error,
	enclosing_function_param,
	is_owning_struct_type,
	type_owns_heap,
} from "./utils/ownership.ts";
import { clone_type, get_or_create_tuple_struct, tuple_struct_name } from "./utils/tuple_struct.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import { default as type_name } from "./utils/type_name.ts";
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

	// Case 1b: expected is a NESTED array (`var int[][] g = [[...]]`) — each
	// element is an inner heap array.
	if (expected?.is_array && expected.elem) {
		return check_as_array_of_arrays(array, status, expected);
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
				// Owning elements (string/mv tuple fields) are seeded uniformly
				// heap by check_as_array_of_tuples (see
				// heapify_owning_tuple_elements) — DECLARED arrays only; the
				// generic/variadic flow (`Map`'s `...[TK, TV] pairs` seeding)
				// keeps its established packing.
				const elem_type = new Type(expected.name!);
				elem_type.tuple_types = tuple_types;
				return check_as_array_of_tuples(
					array,
					status,
					elem_type,
					expected.name !== "tuple" &&
						!status.checking_variadic_arg &&
						!status.is_mono_body_recheck,
				);
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
 * Tuple-element ownership resolution. A bare mv-struct variable element
 * (`[t, c]` where t is a `List<string>`) byte-copies the struct — the
 * tuple's field would alias the local's buffer, and both cleanups free it
 * (double-free). Three outcomes per element:
 *
 *   - explicit `mv t` — transfer (registered like the mv-assignment
 *     path; the tuple's field cleanup owns the buffer now);
 *   - plain `t` stamped by the literal last-use pass — INFERRED transfer
 *     (t is provably never read again, so copy-then-drop and mv are
 *     observationally identical; the mv is free);
 *   - plain `t` still referenced later — rejected, exactly like the
 *     declaration-path mv-struct copy rule: transfer with `mv` or
 *     deep-copy with `.copy()`.
 *
 * Strings and non-mv structs are ordinary by-value copies (views).
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
			// B3: a bare (non-`mv`) parameter of an owning mv struct type is a
			// borrow — transferring it into the tuple (explicitly or via the
			// last-use inference) hands the tuple ownership the caller keeps.
			const transfer_error = borrowed_param_transfer_error(
				enclosing_function_param(status, vn.value),
				status,
			);
			if (transfer_error) {
				add_error(status, transfer_error, value.start);
				rejected = true;
			} else if (vn.is_moved || vn.literal_last_use_move) {
				// Ownership transfers to the tuple: the source's cleanup must
				// skip it (use-after-mv on later reads is checked separately).
				vn.is_moved = true;
				if (!status.moved_variables) status.moved_variables = new Set();
				status.moved_variables.add(vn.value);
			} else {
				add_error(
					status,
					`cannot copy '${t.name}' by value — it owns heap resources; use 'mv ${vn.value}' or '${vn.value}.copy()'`,
					value.start,
				);
				rejected = true;
			}
			continue;
		}
		// A string local is in the same boat as a mv struct: the tuple
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
					`string local '${vn.value}' is read again after the literal — use 'mv ${vn.value}' or '${vn.value}.to_string()'`,
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
 * Structural shape equality for literal-element homogeneity: names must
 * match, arrays match arrays (`int[]` is NOT `int`), generic args match on
 * shape, and tuples match on ELEMENT shape — so two same-shaped tuples are
 * homogeneous (`[[1, "a"], [2, "b"]]` infers an array of tuples, per the
 * SPEC's heterogeneity rule) while differently-shaped tuples stay
 * heterogeneous and tuple-ize the outer literal.
 */
function same_type_shape(a: Type, b: Type): boolean {
	if (a.name !== b.name) return false;
	if (!!a.is_array !== !!b.is_array) return false;
	const at = a.tuple_types ?? [];
	const bt = b.tuple_types ?? [];
	if (at.length !== bt.length) return false;
	if (at.length) return at.every((t, i) => same_type_shape(t, bt[i]));
	const aa = a.type_args ?? [];
	const bb = b.type_args ?? [];
	return aa.length === bb.length && aa.every((t, i) => same_type_shape(t, bb[i]));
}

/**
 * Hoist checked array-literal elements to named consts of `elem_type` so the
 * build can materialize each inner HEAP buffer at a declaration (heap
 * literals are only lowered as declaration initializers). The literal's own
 * checked type stays as-is; the declaration's type drives the materialization.
 */
function hoist_array_elements(array: ArrayValuesNode, status: CheckStatus, elem_type: Type): void {
	for (let i = 0; i < array.values.length; i++) {
		const value = array.values[i];
		// Already a reference to a hoisted temp — a DEEPER level's hoist ran
		// first (three-plus levels: the middle literal's inner rows were
		// hoisted when the middle literal was checked in place). Keep the
		// reference: wrapping it in an alias temp would add a pointer-copy
		// declaration per slot for nothing.
		if (value.node_type === "value" && (value as ValueNode).type?.is_array) continue;
		const decl_name = `_param_${status.var_name_counter.value++}`;
		const decl = new DeclarationNode(
			value.start,
			"private",
			"const",
			decl_name,
			clone_type(elem_type),
			value,
		);
		// The OUTER array owns the buffer: its auto-free frees each inner one,
		// so the temp's own free is skipped (see transferred_to_outer).
		decl.transferred_to_outer = true;
		status.allocations.push(decl);
		array.values[i] = new ValueNode(value.start, decl_name, clone_type(elem_type));
	}
}

/**
 * Validate a nested-array literal against an expected nested array type
 * (`var int[][] g = [[1, 2], [3, 4]]`): each element is checked against the
 * inner HEAP array type, then hoisted so its buffer materializes at a
 * declaration. The outer level stays a fixed stack array of pointers.
 */
function check_as_array_of_arrays(
	array: ArrayValuesNode,
	status: CheckStatus,
	expected: Type,
): boolean {
	const elem = expected.elem!;
	const old_expected = status.expected_type;
	let result = true;
	for (const value of array.values) {
		status.expected_type = clone_type(elem);
		if (!check_node(value, status)) result = false;
	}
	status.expected_type = old_expected;
	if (!result) return false;

	hoist_array_elements(array, status, elem);
	array.type = new Type(expected.name, expected.is_static, expected.is_array, expected.length);
	// A nested array is heap-of-pointers at EVERY level — the outer included
	// (a `struct Array_<T>*` whose slots are row pointers) — so the literal
	// materialises as a heap buffer and rides the heap-array cleanup walks.
	array.type.is_array_heap = true;
	array.type.elem = clone_type(elem);
	if (!array.type.length) {
		array.type.length = new ValueNode(-1, array.values.length.toString(), new Type("int"));
	}
	// Materialize the `Array_<T>` header mono: the hoisted row temps are
	// never themselves run through the declaration checker, so this is the
	// only place their buffer type is instantiated — without it the backends
	// reference a struct that is never emitted (`struct Array_Rec` incomplete).
	instantiate_generic_type(array.type, status);
	return true;
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
 * Make an array-of-tuples literal's OWNING elements uniformly heap: every
 * owning constructor ARGUMENT (a `string`/mv value) is deep-copied via
 * `.copy()` and hoisted to a temp whose cleanup is transferred to the
 * element — the constructor byte-assigns the copy, so the element slots own
 * heap fields and the scope-exit element walk frees them exactly once.
 * Without this the fields hold literal-seeded rodata that the element
 * teardown would try to free (AUDIT-STALE-FREE).
 *
 * A bare owning tuple VARIABLE element is rejected: copying it would alias
 * its fields (same rule as copying any owning struct by value).
 */
function heapify_owning_tuple_elements(array: ArrayValuesNode, status: CheckStatus): void {
	for (let i = 0; i < array.values.length; i++) {
		const value = array.values[i];
		const vt = type_from_value_node(value, status);
		if (!vt.name?.startsWith("_Tuple_") || !type_owns_heap(vt, status)) continue;
		// The element must be a fresh tuple CONSTRUCTION to seed its args.
		if (value.node_type !== "func_call") {
			add_error(
				status,
				`cannot copy '${type_name(vt)}' into an array of tuples by value — it owns heap resources; use a fresh tuple literal or '.copy()'`,
				value.start,
			);
			continue;
		}
		const call = value as FunctionCallNode;
		for (let j = 0; j < call.params.length; j++) {
			const param = call.params[j];
			const pt = type_from_value_node(param, status);
			if (!type_owns_heap(pt, status)) continue;
			const old_expected = status.expected_type;
			status.expected_type = clone_type(pt);
			const copy_call = new AccessNode(
				param.start,
				param,
				new AccessFunctionCallNode(param.start, "copy", clone_type(pt)),
			);
			if (!check_node(copy_call, status)) {
				status.expected_type = old_expected;
				continue;
			}
			status.expected_type = old_expected;
			// Hoist the copy result: a call-result string marshalled straight
			// into a constructor loses its hidden length half on aarch64.
			const decl_name = `_param_${status.var_name_counter.value++}`;
			const decl = new DeclarationNode(
				param.start,
				"private",
				"const",
				decl_name,
				clone_type(pt),
				copy_call,
			);
			decl.transferred_to_outer = true;
			status.allocations.push(decl);
			call.params[j] = new ValueNode(param.start, decl_name, clone_type(pt));
		}
	}
}

/**
 * Owning array elements must be uniquely owned by the array: the scope-exit
 * teardown destroys each element's owned fields (and frees each string
 * slot), so a bare variable element would alias the donor (which frees its
 * own copy too — a double free). Mirror the tuple-literal rule: an explicit
 * or inferred `mv` transfers, `.copy()`/fresh constructions own their bytes,
 * and a plain variable read is rejected. Tuple/anon structs keep their
 * literal-time ownership handling; nested literals skip this (their rows are
 * internal hoisted temps, and each row literal is checked on its own).
 */
function check_owning_struct_array_elements(
	array: ArrayValuesNode,
	elem_type: Type,
	status: CheckStatus,
): boolean {
	const is_string = elem_type?.name === "string";
	const is_owning_struct =
		!!elem_type?.name &&
		!is_string &&
		!elem_type.name.startsWith("_Tuple_") &&
		!elem_type.name.startsWith("_Anon_") &&
		is_owning_struct_type(elem_type, status);
	if (!is_string && !is_owning_struct) return false;
	let rejected = false;
	for (const value of array.values) {
		const vn = value as ValueNode;
		if (vn.node_type !== "value") continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(vn.value) || vn.value === "null") continue;
		const t = type_from_value_node(value, status);
		if (t.is_array) continue;
		if (is_string) {
			if (t.name !== "string" || t.is_view || t.is_array) continue;
		} else if (t.name !== elem_type.name || !is_owning_struct_type(t, status)) {
			continue;
		}
		// B3: transferring a bare (non-`mv`) owning-struct parameter is a
		// borrow the caller keeps — the same rejection tuple literals use.
		const transfer_error = borrowed_param_transfer_error(
			enclosing_function_param(status, vn.value),
			status,
		);
		if (transfer_error) {
			add_error(status, transfer_error, value.start);
			rejected = true;
		} else if (vn.is_moved || vn.literal_last_use_move) {
			vn.is_moved = true;
			if (!status.moved_variables) status.moved_variables = new Set();
			status.moved_variables.add(vn.value);
		} else {
			add_error(
				status,
				is_string
					? `string local '${vn.value}' is read again after the literal — use 'mv ${vn.value}' or '${vn.value}.to_string()'`
					: `cannot copy '${t.name}' by value — it owns heap resources; use 'mv ${vn.value}' or '${vn.value}.copy()'`,
				value.start,
			);
			rejected = true;
		}
	}
	return rejected;
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
	seed_owning: boolean,
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

	// Owning elements (string/mv tuple fields) get uniformly-heap seeding so
	// the element teardown walks free exactly one copy.
	if (result && seed_owning) heapify_owning_tuple_elements(array, status);

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
		const all_same =
			meaningful.length > 0 && meaningful.every((t) => same_type_shape(t, first_meaningful));

		// A homogeneous tuple-element list infers an ARRAY of tuples; owning
		// elements are seeded uniformly heap below (heapify), matching the
		// mv-struct array convention.
		if (all_same && first_meaningful?.tuple_types?.length) {
			heapify_owning_tuple_elements(array, status);
		}

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
		// The expected compile-time length must agree with the literal's own
		// element count. A MISMATCH means the expected type carries a stale
		// stamped length from an earlier call site of the same unsized
		// `T[]` parameter (check_function_call's length stamping) — keep the
		// literal's true count so the call-site conflict check rejects it;
		// inheriting the stale bound here would silently truncate the
		// literal to it.
		if (
			!old_expected.length ||
			String((old_expected.length as ValueNode).value) === String(array.values.length)
		) {
			array.type.length = old_expected.length;
		}
	} else if (!array.type.name) {
		// Infer element type from first value. A generic element flattens to
		// its mono name (same as the parse-time `Array<T>`/`T[]` spellings)
		// so the container sites key one mono (`Box_Cell`, not bare `Box`
		// whose type args would be lost on this `new Type(name)`).
		const first_type = value_types[0];
		if (first_type?.is_array) {
			// NESTED array (`[[1, 2], [3, 4]]`, `[[["a"]]]`): every level — the
			// outer included — becomes a HEAP buffer (a level's slots are
			// `Array_<T>*` row pointers; the innermost holds scalars), hoisted
			// to named consts so the build materializes each buffer at a
			// declaration.
			const elem = new Type(first_type.name);
			elem.is_array = true;
			elem.is_array_heap = true;
			elem.elem = first_type.elem;
			hoist_array_elements(array, status, elem);
			array.type = new Type(first_type.name);
			array.type.is_array = true;
			array.type.is_array_heap = true;
			array.type.elem = elem;
			array_item_type = clone_type(elem);
			// Materialize the `Array_<T>` header mono for the hoisted row
			// temps (see check_as_array_of_arrays).
			instantiate_generic_type(array.type, status);
		} else if (first_type) {
			const elem_name = first_type.type_args?.length ? mono_type_name(first_type) : first_type.name;
			array.type = new Type(elem_name);
			array.type.is_array = true;
			// A tuple element keeps its shape on the outer type so downstream
			// tuple handling (Case 2 materialization, destructuring
			// `var [a, b] = pairs.at(i)`) sees the element types.
			if (first_type.tuple_types?.length) {
				array.type.tuple_types = first_type.tuple_types;
			}
		}
		array_item_type = array.type.elem ? clone_type(array.type.elem) : new Type(array.type.name);
		if (first_type?.tuple_types?.length) {
			array_item_type.tuple_types = first_type.tuple_types;
		}
	} else {
		array_item_type = new Type(array.type.name);
	}

	for (let i = 0; i < value_types.length; i++) {
		const value = array.values[i];
		const vt = value_types[i];
		if (!vt) continue;
		// STRUCT_PLAN_3 B4: a value-struct conformer element is accepted —
		// it boxes into the trait-typed slot (the build materializes the
		// heap handle; the trait annotation is the marker).
		check_type_and_value_match(
			array_item_type,
			vt,
			value_from_value_node(value),
			status,
			value.start,
			"array",
		);
	}

	// Owning array elements: the array's scope-exit teardown reclaims each
	// element's owned fields, so every slot must uniquely own them — a bare
	// variable element would alias the donor (a double free). Nested literals
	// skip this: their rows are internal hoisted temps, and each row literal
	// already ran this check on its own elements.
	if (!array.type.elem && check_owning_struct_array_elements(array, array_item_type, status)) {
		result = false;
	}

	if (!array.type.length) {
		array.type.length = new ValueNode(-1, array.values.length.toString(), new Type("int"));
	}
	array.type.is_array = true;

	return result;
}
