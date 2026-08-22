import add_error from "../add_error.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import clone_status from "./utils/clone_status.ts";
import evaluate_const_condition from "./utils/evaluate_const_condition.ts";
import {
	apply_bounds,
	apply_negated_bounds,
	intersect_strs,
	union_max,
	union_min,
} from "./utils/flow_bounds.ts";
import get_null_check_var from "./utils/get_null_check_var.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name, { is_bool_condition } from "./utils/type_name.ts";

/** Check if a block always exits (e.g. contains a top-level return/break/continue) */
function block_always_returns(node: { statements: BaseNode[] }): boolean {
	return node.statements.some(
		(s) => s.node_type === "return" || s.node_type === "break" || s.node_type === "continue",
	);
}

export default function check_if_else_node(if_else: IfElseNode, status: CheckStatus) {
	check_node(if_else.condition, status);
	const condition_type = type_from_value_node(if_else.condition, status);
	if (!is_bool_condition(condition_type)) {
		add_error(
			status,
			`If/else condition must be a bool, not ${type_name(condition_type)}`,
			if_else.condition.start,
		);
	}

	const null_check = get_null_check_var(if_else.condition);

	status.stack.push(if_else);
	let if_status = clone_status(status);
	let else_status = clone_status(status);

	if (null_check) {
		if (!null_check.is_null_check) {
			const if_var = if_status.values.find((v) => v.name === null_check.name);
			if (if_var) if_var.is_null = false;
		} else {
			const else_var = else_status.values.find((v) => v.name === null_check.name);
			if (else_var) else_var.is_null = false;
		}
	}

	// For && conditions with null check on the left side (e.g. thing != null && ...),
	// narrow is_null for the if body
	if (if_else.condition.node_type === "op") {
		const cond_op = if_else.condition as OperationNode;
		if (cond_op.op === "&&") {
			const left_check = get_null_check_var(cond_op.left_value);
			if (left_check && !left_check.is_null_check) {
				const if_var = if_status.values.find((v) => v.name === left_check.name);
				if (if_var) if_var.is_null = false;
			}
		}
	}

	// Establish flow-sensitive bounds from condition (e.g. if j < list.length)
	apply_bounds(if_else.condition, if_status);

	if (if_else.if_branch) {
		check_block_node(if_else.if_branch, if_status);
	}
	if (if_else.else_branch) {
		check_block_node(if_else.else_branch, else_status);
	}
	status.stack.pop();

	// Evaluate the condition at compile time if possible
	const const_cond = evaluate_const_condition(if_else.condition, status);
	const if_reachable = const_cond !== false;
	const else_reachable = const_cond !== true;
	const has_else = !!if_else.else_branch;

	// Check which branches always exit (e.g. guard clause with return)
	const if_returns = if_else.if_branch && block_always_returns(if_else.if_branch);
	const else_returns = if_else.else_branch && block_always_returns(if_else.else_branch);

	// A branch "falls through" if it's reachable AND doesn't always exit.
	// The implicit else (no else branch) always falls through.
	const if_falls_through = if_reachable && !if_returns;
	const else_falls_through = else_reachable && (!has_else || !else_returns);

	// For a no-else `if cond { ... }` where the implicit else is reachable,
	// code after the if can also be reached when cond was FALSE — so the
	// negation of cond holds for that path. Apply the negated bounds to the
	// parent directly so the post-if state carries them. This runs alongside
	// the reconciliation (which copies the if-branch's state) — both paths'
	// facts are recorded; verification succeeds if either path's bound
	// discharges the constraint. The previous code only did this for guard
	// clauses (if_returns); extending it to the no-else fall-through case is
	// what makes a clamp pattern like `if e > text.length { e = text.length }`
	// establish `e <= text.length` afterwards.
	//
	// Guard clauses (if_returns) are EXCLUDED here and handled after the
	// reconciliation loop instead: the loop's else-path copy for `var` locals
	// would otherwise clobber these bounds (assignment in an earlier clamp
	// cleared them, and the copy restores the cleared pre-if state), which is
	// exactly why a guard after a clamp used to lose its facts.
	if (!has_else && else_reachable && !if_returns) {
		apply_negated_bounds(if_else.condition, status);
	}

	for (let [i, value] of status.values.entries()) {
		// is_set reconciliation: only branches that fall through contribute to post-if state
		const contributing_sets: boolean[] = [];
		if (if_falls_through) contributing_sets.push(!!if_status.values[i].is_set);
		if (else_falls_through)
			contributing_sets.push(has_else ? !!else_status.values[i].is_set : false);

		const contributing_count = contributing_sets.length;
		const set_count = contributing_sets.filter((s) => s).length;

		if (value.declaration === "const" && !value.is_set) {
			if (contributing_count > 0 && set_count === contributing_count) {
				value.is_set = true;
			} else if (set_count > 0 && set_count < contributing_count) {
				add_error(status, `Const set incompletely: ${value.name}`, if_else.start);
			}
		}

		if (value.declaration === "var" && !value.is_set) {
			if (contributing_count > 0 && set_count === contributing_count) {
				value.is_set = true;
			}
		}

		// is_null propagation: if only one branch falls through, inherit its null state.
		// This handles guard clauses like: if thing == null { return } — after this,
		// thing is known to be non-null.
		if (if_falls_through && !else_falls_through) {
			value.is_null = if_status.values[i].is_null;
		} else if (else_falls_through && !if_falls_through) {
			value.is_null = else_status.values[i].is_null;
		}
		// If both fall through, keep original is_null (conservative)

		// Borrow invalidation: a borrow invalidated in any branch that can fall
		// through is invalidated afterwards (either path may have executed).
		if (if_falls_through && if_status.values[i]?.borrow_invalidated) {
			value.borrow_invalidated = true;
		}
		if (else_falls_through && else_status.values[i]?.borrow_invalidated) {
			value.borrow_invalidated = true;
		}

		// Bounds/range reconciliation: a `var` reassigned in any fall-through
		// branch must not keep its pre-if bounds in the parent — otherwise
		// `if c { i = 100 } arr.at(i)` would wrongly prove `i < arr.length`
		// using the stale pre-if range. The sound merge is:
		//   - ranges: union (MIN lower, MAX upper); undefined if EITHER side is
		//     undefined (i.e. the branch cleared it via reassignment).
		//   - bound exprs: intersection (only keep exprs that hold in BOTH
		//     branches); undefined if either side is undefined.
		// When only one branch falls through, copy its bounds verbatim.
		const if_v = if_status.values[i];
		const else_v = else_status.values[i];
		if (value.declaration === "var") {
			if (if_falls_through && else_falls_through && has_else) {
				value.range_lower = union_min(if_v?.range_lower, else_v?.range_lower);
				value.range_upper = union_max(if_v?.range_upper, else_v?.range_upper);
				value.upper_bound_exprs = intersect_strs(
					if_v?.upper_bound_exprs,
					else_v?.upper_bound_exprs,
				);
				value.lower_bound_exprs = intersect_strs(
					if_v?.lower_bound_exprs,
					else_v?.lower_bound_exprs,
				);
				value.upper_bound_inclusive_exprs = intersect_strs(
					if_v?.upper_bound_inclusive_exprs,
					else_v?.upper_bound_inclusive_exprs,
				);
				value.lower_bound_inclusive_exprs = intersect_strs(
					if_v?.lower_bound_inclusive_exprs,
					else_v?.lower_bound_inclusive_exprs,
				);
				value.known_length = union_known(if_v?.known_length, else_v?.known_length);
			} else if (if_falls_through) {
				value.range_lower = if_v?.range_lower;
				value.range_upper = if_v?.range_upper;
				value.upper_bound_exprs = if_v?.upper_bound_exprs?.slice();
				value.lower_bound_exprs = if_v?.lower_bound_exprs?.slice();
				value.upper_bound_inclusive_exprs = if_v?.upper_bound_inclusive_exprs?.slice();
				value.lower_bound_inclusive_exprs = if_v?.lower_bound_inclusive_exprs?.slice();
				value.upper_bound_expr = if_v?.upper_bound_expr;
				value.lower_bound_expr = if_v?.lower_bound_expr;
				value.known_length = if_v?.known_length;
				value.alias_of = if_v?.alias_of;
			} else if (else_falls_through) {
				value.range_lower = else_v?.range_lower;
				value.range_upper = else_v?.range_upper;
				value.upper_bound_exprs = else_v?.upper_bound_exprs?.slice();
				value.lower_bound_exprs = else_v?.lower_bound_exprs?.slice();
				value.upper_bound_inclusive_exprs = else_v?.upper_bound_inclusive_exprs?.slice();
				value.lower_bound_inclusive_exprs = else_v?.lower_bound_inclusive_exprs?.slice();
				value.upper_bound_expr = else_v?.upper_bound_expr;
				value.lower_bound_expr = else_v?.lower_bound_expr;
				value.known_length = else_v?.known_length;
				value.alias_of = else_v?.alias_of;
			}
		}
	}

	// Guard-clause: an `if cond { ...always exits... }` with no else
	// means only the implicit-else path reaches code after the if, so the
	// NEGATION of cond holds unconditionally there — e.g.
	//   if i < 0 || i >= list.length { return }
	//   return list.at(i)        // now provably i >= 0 && i < list.length
	// This runs AFTER the reconciliation loop (unlike the fall-through case
	// above): the loop's else-path copy for `var` locals restores the pre-if
	// state — which an earlier clamp's assignment cleared the bounds on — so
	// applying the negation first would have it clobbered. Applying it here
	// re-seeds the bounds on top of the copied state, which is what makes the
	// natural clamp-then-guard style verify:
	//   var int s = start
	//   if s < 0 { s = 0 }
	//   if s < 0 || s > text.length { return }
	//   text.slice(s, ...)
	if (!has_else && if_returns && else_reachable) {
		apply_negated_bounds(if_else.condition, status);
	}

	if (if_else.if_branch && !if_else.else_branch) {
		const parent = status.stack.at(-1);
		if (parent && (parent.node_type === "declare" || parent.node_type === "assign")) {
			add_error(status, "If expression must have an else branch", if_else.start);
		}
	}
}

/**
 * Merge two `known_length` flow facts: a value survives only if BOTH branches
 * agree on the same length. undefined if either side is undefined (the branch
 * re-assigned the array, or didn't establish the fact).
 */
function union_known(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined || b === undefined) return undefined;
	return a === b ? a : undefined;
}
