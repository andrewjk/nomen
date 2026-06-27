import add_error from "../add_error.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import clone_status from "./utils/clone_status.ts";
import evaluate_const_condition from "./utils/evaluate_const_condition.ts";
import { apply_bounds } from "./utils/flow_bounds.ts";
import get_null_check_var from "./utils/get_null_check_var.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";

/** Check if a block always exits (e.g. contains a top-level return/break/continue) */
function block_always_returns(node: { statements: BaseNode[] }): boolean {
	return node.statements.some(
		(s) => s.node_type === "return" || s.node_type === "break" || s.node_type === "continue",
	);
}

export default function check_if_else_node(if_else: IfElseNode, status: CheckStatus) {
	check_node(if_else.condition, status);
	const condition_type = type_from_value_node(if_else.condition, status);
	if (type_name(condition_type) !== "bool") {
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
	}

	if (if_else.if_branch && !if_else.else_branch) {
		const parent = status.stack.at(-1);
		if (parent && (parent.node_type === "declare" || parent.node_type === "assign")) {
			add_error(status, "If expression must have an else branch", if_else.start);
		}
	}
}
