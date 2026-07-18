import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { borrow_depth_of, borrow_owner_of } from "./utils/borrow.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import evaluate_const_condition from "./utils/evaluate_const_condition.ts";
import { snapshot_bounds, track_assignment_bounds } from "./utils/flow_bounds.ts";
import { is_class_type, is_owning_struct_type } from "./utils/ownership.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_assignment_node(
	assign: AssignmentNode,
	status: CheckStatus,
): boolean {
	// For compound assignment (x += 1), the left value is read, so check is_set.
	// For regular assignment (x = 5), the left value is only written.
	const is_compound = !!assign.operator;
	if (!is_compound) {
		status.is_assignment_target = true;
	}
	// Reassigning a whole moved variable (`a = ...`, not `a.field = ...`)
	// revalidates it: drop it from the moved set before the left value is
	// checked, so the read of the target here is not itself flagged. A field
	// assignment (`a.field = ...`) does NOT revalidate `a` and is left to error.
	if (
		!is_compound &&
		assign.left_value.node_type === "value" &&
		status.moved_variables?.has((assign.left_value as ValueNode).value)
	) {
		status.moved_variables.delete((assign.left_value as ValueNode).value);
	}
	if (!check_node(assign.left_value, status)) {
		status.is_assignment_target = false;
		return false;
	}
	status.is_assignment_target = false;

	// If the RHS is a lambda and the LHS is a function-typed variable, infer the
	// lambda's parameter and return types from the declared function signature.
	const lhs_value_name = value_from_value_node(assign.left_value);
	const lhs_value = status.values.find((v) => v.name === lhs_value_name);
	if (
		assign.right_value.node_type === "func" &&
		lhs_value?.func_params &&
		lhs_value.func_params.length
	) {
		const rhs_func = assign.right_value as FunctionNode;
		rhs_func.name = lhs_value_name;
		if (rhs_func.params.length === lhs_value.func_params.length) {
			for (let i = 0; i < rhs_func.params.length; i++) {
				if (!rhs_func.params[i].type.name && lhs_value.func_params[i].type.name) {
					rhs_func.params[i].type = lhs_value.func_params[i].type;
				}
			}
		}
		if (lhs_value.func_return_type && !rhs_func.return_type.name) {
			rhs_func.return_type = lhs_value.func_return_type;
		}
	}

	const old_expected_type = status.expected_type;
	status.expected_type = type_from_value_node(assign.left_value, status);
	const result = check_node(assign.right_value, status);
	status.expected_type = old_expected_type;
	if (!result) {
		return false;
	}

	// Make sure the left value exists and can be assigned to
	// * If this is a variable, it's the variable itself e.g. for `x = 5` we would
	//   check that `x` exists and can be assigned to
	// * If this is an access, it's the root target e.g. for `person.address.zip =
	//   1234` we would check that `person` exists and can be assigned to
	const left_value_name = value_from_value_node(assign.left_value);
	const left_value = status.values.find((v) => v.name === left_value_name);
	if (!left_value) {
		add_error(status, `Unknown variable: ${left_value_name}`, assign.left_value!.start);
		return false;
	} else if (
		left_value.declaration !== "var" &&
		!left_value.type.is_ref &&
		left_value_name !== "self"
	) {
		if (left_value.is_set) {
			add_error(status, `Assignment to const: ${left_value_name}`, assign.left_value!.start);
			return false;
		} else {
			left_value.is_set = true;
		}
	} else if (left_value.declaration === "var") {
		left_value.is_set = true;
		// If the RHS is a shifted bound referencing the LHS itself (e.g.
		// `i = i + 6`), snapshot the LHS's current bounds BEFORE clearing so
		// track_assignment_bounds can propagate them (e.g. `i >= 0` ⇒ `i >= 6`).
		const self_snapshot =
			!is_compound &&
			left_value_name === left_value.name &&
			is_self_shifted(assign.right_value, left_value.name)
				? snapshot_bounds(left_value.name, status)
				: undefined;
		// Clear range bounds: assignment invalidates for-loop range knowledge
		left_value.range_lower = undefined;
		left_value.range_upper = undefined;
		// Clear flow-sensitive bounds: assignment invalidates bounds from if/while
		left_value.upper_bound_expr = undefined;
		left_value.lower_bound_expr = undefined;
		left_value.upper_bound_exprs = undefined;
		left_value.lower_bound_exprs = undefined;
		left_value.upper_bound_inclusive_exprs = undefined;
		left_value.lower_bound_inclusive_exprs = undefined;
		left_value.alias_of = undefined;
		left_value.class_alias_of = undefined;
		// Re-track bounds if the RHS establishes new ones (e.g. cap = buf.get_cap()).
		// Skip for compound assignments (+=, -=, etc.) since the RHS is a delta,
		// not the new value.
		if (!is_compound && left_value_name === left_value.name) {
			track_assignment_bounds(left_value.name, assign.right_value, status, self_snapshot);
		}
	}

	// Update is_null based on the RHS value
	if (left_value.declaration === "var") {
		const rhs_is_null =
			assign.right_value.node_type === "value" && (assign.right_value as any).value === "null";
		left_value.is_null = rhs_is_null || undefined;
	}

	// Make sure that the types match
	// * If this is a variable, it's the variable itself e.g. for `x = 5` we would
	//   check that the types of `x` and `5` match
	// * If this is an access, it's the field target e.g. for `person.address.zip
	//   = 1234` we would check that the types of `zip` and `1234` match
	//if (left_value)
	check_type_and_value_match(
		type_from_value_node(assign.left_value, status),
		type_from_value_node(assign.right_value, status),
		value_from_value_node(assign.right_value),
		status,
		assign.right_value.start,
		"assignment",
	);

	// Reject byte-copying a struct that transitively owns heap resources from
	// another variable — both variables would free the same backing data
	// (double-free). Use `mov` (`b = mov a`) to transfer ownership or `.copy()`
	// for a deep copy. A `swap` assignment transfers ownership (the source is
	// replaced), so it is allowed; fresh allocations (constructors / function
	// returns) arrive as non-value nodes and are moves, not copies. This mirrors
	// the declaration-side check so the two copy sites are consistent.
	if (
		!is_compound &&
		!assign.swap &&
		assign.right_value.node_type === "value" &&
		!assign.right_value.is_moved
	) {
		const rhs_type = type_from_value_node(assign.right_value, status);
		if (rhs_type.name && is_owning_struct_type(rhs_type, status)) {
			add_error(
				status,
				`cannot copy '${rhs_type.name}' by value — it owns heap resources; use .copy() or mov`,
				assign.right_value.start,
			);
		}
	}

	// `b = mov a` (no swap) transfers ownership: the source `a` is moved and may
	// not be used again until it is reassigned. (A swap revalidates the source,
	// so it is not marked; func-call `mov` params are marked in check_function_call.)
	if (assign.right_value.node_type === "value" && assign.right_value.is_moved && !assign.swap) {
		if (!status.moved_variables) status.moved_variables = new Set();
		status.moved_variables.add((assign.right_value as ValueNode).value);
	}

	// Check field constraints on assignment (e.g. foo.x = value where x has a constraint)
	if (assign.left_value.node_type === "access") {
		const access = assign.left_value as AccessNode;
		if (access.access.node_type === "access_field") {
			const field_access = access.access as AccessFieldNode;
			const target_type = type_from_value_node(access.target, status);
			const struct = status.structs.findLast((s) => s.name === target_type.name);
			const field = struct?.fields.find((f) => f.name === field_access.name);
			if (field?.constraint) {
				let arg_value: number | boolean | undefined;
				if (assign.right_value.node_type === "value") {
					const vn = assign.right_value as ValueNode;
					if (/^[+-]?\d+$/.test(vn.value)) arg_value = parseInt(vn.value, 10);
					if (vn.value === "true") arg_value = true;
					if (vn.value === "false") arg_value = false;
				}
				if (arg_value !== undefined) {
					const saved_length = status.values.length;
					status.values.push({
						declaration: "const",
						name: field.name,
						type: field.type,
						is_set: true,
						const_value: arg_value,
					});
					const satisfied = evaluate_const_condition(field.constraint, status);
					status.values.length = saved_length;
					if (satisfied === false) {
						add_error(status, `Constraint not satisfied: ${field.name}`, assign.right_value.start);
					}
				}
			}
		}
	}

	// Check variable constraints on simple assignment (e.g. x = 2 where x has a constraint)
	if (assign.left_value.node_type === "value" && left_value.constraint) {
		let arg_value: number | boolean | undefined;
		if (assign.right_value.node_type === "value") {
			const vn = assign.right_value as ValueNode;
			if (/^[+-]?\d+$/.test(vn.value)) arg_value = parseInt(vn.value, 10);
			if (vn.value === "true") arg_value = true;
			if (vn.value === "false") arg_value = false;
		}
		if (arg_value !== undefined) {
			const saved_length = status.values.length;
			status.values.push({
				declaration: "const",
				name: left_value.name,
				type: left_value.type,
				is_set: true,
				const_value: arg_value,
			});
			const satisfied = evaluate_const_condition(left_value.constraint, status);
			status.values.length = saved_length;
			if (satisfied === false) {
				add_error(status, `Constraint not satisfied: ${left_value.name}`, assign.right_value.start);
			}
		}
	}

	const rhs_type = type_from_value_node(assign.right_value, status);
	const rhs_is_field_access =
		assign.right_value.node_type === "access" &&
		(assign.right_value as AccessNode).access.node_type === "access_field";
	if (rhs_is_field_access && rhs_type.name) {
		if (is_class_type(rhs_type.name, status)) {
			// A class field is a borrowed reference owned by its parent; extracting
			// it requires mov+swap so the parent's slot is revalidated.
			if (!assign.swap) {
				add_error(
					status,
					`cannot assign class field '${rhs_type.name}' from another owner, use mov with swap`,
					assign.right_value.start,
				);
			}
		} else if (is_owning_struct_type(rhs_type, status)) {
			// An owning struct field cannot be byte-copied out (double-free); move
			// it out with a swap that revalidates the field.
			if (!assign.right_value.is_moved) {
				const field_name = (assign.right_value as AccessNode).access.name;
				add_error(
					status,
					`cannot copy '${rhs_type.name}' out of field '${field_name}' by value — it owns heap resources; use mov with swap`,
					assign.right_value.start,
				);
			} else if (!assign.swap) {
				add_error(
					status,
					`mov out of a field requires a swap to revalidate it`,
					assign.right_value.start,
				);
			}
		}
	}

	// Borrow-lifetime check: a borrowed class reference (a variable that holds
	// a borrow) may not be assigned to a variable declared in an outer scope —
	// that would let the borrow outlive the instance it points into. To move
	// ownership out, use `mov` (with swap). Within the same/inner scope the
	// target simply becomes a borrow too.
	if (!assign.swap && left_value.declaration === "var") {
		const rhs_borrow_depth = borrow_depth_of(assign.right_value, status);
		if (rhs_borrow_depth !== undefined) {
			if (left_value.decl_depth !== undefined && left_value.decl_depth < rhs_borrow_depth) {
				add_error(
					status,
					`borrow escapes its scope — use 'mov' (with swap) to transfer ownership`,
					assign.right_value.start,
				);
			} else {
				left_value.borrow_depth = rhs_borrow_depth;
				left_value.borrowed_from = borrow_owner_of(assign.right_value, status);
				// Re-assigning a (possibly invalidated) borrow refreshes it: the
				// new value is a fresh borrow rooted at its own owner.
				left_value.borrow_invalidated = false;
			}
		} else {
			left_value.borrow_depth = undefined;
			left_value.borrowed_from = undefined;
			left_value.borrow_invalidated = false;
		}
	}

	// Record whether a live field/method borrow OR object-level alias of the lhs
	// exists, so the build can decide between eager reclamation (no reference →
	// safe to free the old instance immediately, which is what makes loop
	// reassignment sound) and deferred reclamation (reference present → keep the
	// old instance alive until that reference's scope ends).
	if (!assign.swap) {
		assign.has_live_borrow = status.values.some(
			(v) => v.borrowed_from === left_value_name || v.class_alias_of === left_value_name,
		);
	}

	if (assign.swap) {
		check_node(assign.swap, status);
		const left_type = type_from_value_node(assign.left_value, status);
		const swap_type = type_from_value_node(assign.swap, status);
		check_type_and_value_match(left_type, swap_type, undefined, status, assign.swap.start, "swap");
	}

	return true;
}

/**
 * Returns true iff `value` is a shifted bound `name + N`, `N + name`,
 * `name - N`, or `N - name` for some integer N — i.e. an expression whose
 * flow-sensitive bounds can be derived by shifting `name`'s existing bounds.
 * Used to decide whether to snapshot the LHS's bounds before clearing them.
 */
function is_self_shifted(value: AssignmentNode["right_value"], name: string): boolean {
	if (value.node_type !== "op") return false;
	const op = value as OperationNode;
	if (op.op !== "+" && op.op !== "-") return false;
	const is_int_literal = (n: BaseNode) =>
		n.node_type === "value" && /^[+-]?\d+$/.test((n as ValueNode).value);
	const is_name = (n: BaseNode) => n.node_type === "value" && (n as ValueNode).value === name;
	return (
		(is_int_literal(op.left_value) && is_name(op.right_value)) ||
		(is_name(op.left_value) && is_int_literal(op.right_value))
	);
}
