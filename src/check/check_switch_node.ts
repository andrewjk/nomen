import add_error from "../add_error.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import block_always_returns from "./utils/always_returns.ts";
import clone_status from "./utils/clone_status.ts";
import { apply_bounds, intersect_strs, union_max, union_min } from "./utils/flow_bounds.ts";
import { intersect_moved_variables, outer_scope_moved } from "./utils/moved_variables.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name, { is_bool_condition } from "./utils/type_name.ts";

export default function check_switch_node(switch_node: SwitchNode, status: CheckStatus) {
	status.stack.push(switch_node);

	// The enclosing scope's values length when the arm clones are taken:
	// moved names whose innermost declaration sits at or beyond this index
	// are arm-local and must not merge.
	const arms_base = status.values.length;

	let branch_statuses: CheckStatus[] = [];

	for (let switch_case of switch_node.cases) {
		check_node(switch_case.condition, status);
		// The case condition's parent is the switch (not a block), so
		// promote_allocations can't attach hoisted call-argument temps
		// (`const _param_N = <arg>`) — they would stay pending and leak into
		// the next checked statement, which the builders emit INSIDE the case
		// branch (after the `if` that reads them: an undeclared identifier /
		// undefined `_param_N` link error). Anchor them on the condition node
		// instead: build_switch_node builds the condition first, and its
		// top-level statement splitter hoists the emitted declarations ahead
		// of the `if`.
		if (status.allocations.length) {
			switch_case.condition.allocations ??= [];
			switch_case.condition.allocations.push(...status.allocations);
			status.allocations.length = 0;
		}
		const condition_type = type_from_value_node(switch_case.condition, status);
		if (!is_bool_condition(condition_type)) {
			add_error(
				status,
				`Switch case condition must be a bool, not ${type_name(condition_type)}`,
				switch_case.condition.start,
			);
		}

		let case_status = clone_status(status);
		// A switch case is effectively an `if (condition) { branch }` — apply
		// flow-sensitive bounds (e.g. `case order_len >= size` ⟹ `order_len >= size`
		// inside the branch) so constrained accesses in the branch can verify.
		apply_bounds(switch_case.condition, case_status);
		check_block_node(switch_case.branch, case_status);
		branch_statuses.push(case_status);
	}

	if (switch_node.else_branch) {
		let else_status = clone_status(status);
		check_block_node(switch_node.else_branch, else_status);
		branch_statuses.push(else_status);
	}

	status.stack.pop();

	for (let [i, value] of status.values.entries()) {
		if (value.declaration === "const" && !value.is_set) {
			let set_count = branch_statuses.filter((bs) => bs.values[i]?.is_set).length;
			if (set_count === branch_statuses.length && branch_statuses.length > 0) {
				value.is_set = true;
			} else if (set_count > 0) {
				add_error(status, `Const set incompletely: ${value.name}`, switch_node.start);
			}
		}

		if (value.declaration === "var" && !value.is_set) {
			let set_count = branch_statuses.filter((bs) => bs.values[i]?.is_set).length;
			if (set_count === branch_statuses.length && branch_statuses.length > 0) {
				value.is_set = true;
			}
		}

		// Borrow invalidation: a borrow invalidated in any case (or else) that
		// can fall through is invalidated afterwards — either may have run.
		if (branch_statuses.some((bs) => bs.values[i]?.borrow_invalidated)) {
			value.borrow_invalidated = true;
		}

		// Bounds/range reconciliation: a `var` reassigned in any branch must
		// not keep its pre-switch bounds in the parent. The sound merge across
		// N branches: ranges take the loosest (MIN lower, MAX upper) and become
		// undefined if ANY branch cleared them; bound exprs are intersected
		// (only exprs holding in ALL branches survive).
		if (value.declaration === "var" && branch_statuses.length > 0) {
			const first = branch_statuses[0].values[i];
			value.range_lower = branch_statuses.reduce<number | undefined>(
				(acc, bs) => union_min(acc, bs.values[i]?.range_lower),
				first?.range_lower,
			);
			value.range_upper = branch_statuses.reduce<number | undefined>(
				(acc, bs) => union_max(acc, bs.values[i]?.range_upper),
				first?.range_upper,
			);
			value.upper_bound_exprs = branch_statuses.reduce<string[] | undefined>(
				(acc, bs) => intersect_strs(acc, bs.values[i]?.upper_bound_exprs),
				first?.upper_bound_exprs?.slice(),
			);
			value.lower_bound_exprs = branch_statuses.reduce<string[] | undefined>(
				(acc, bs) => intersect_strs(acc, bs.values[i]?.lower_bound_exprs),
				first?.lower_bound_exprs?.slice(),
			);
			value.upper_bound_inclusive_exprs = branch_statuses.reduce<string[] | undefined>(
				(acc, bs) => intersect_strs(acc, bs.values[i]?.upper_bound_inclusive_exprs),
				first?.upper_bound_inclusive_exprs?.slice(),
			);
			value.lower_bound_inclusive_exprs = branch_statuses.reduce<string[] | undefined>(
				(acc, bs) => intersect_strs(acc, bs.values[i]?.lower_bound_inclusive_exprs),
				first?.lower_bound_inclusive_exprs?.slice(),
			);
			value.nonzero_exprs = branch_statuses.reduce<string[] | undefined>(
				(acc, bs) => intersect_strs(acc, bs.values[i]?.nonzero_exprs),
				first?.nonzero_exprs?.slice(),
			);
		}
	}

	// Moved-variable reconciliation across the arms (same merge as if/else):
	// a name stays moved after the switch only when every arm that can fall
	// through ends with it moved (both-moved ⇒ moved); an arm that always
	// exits contributes nothing. A switch without else can skip every arm
	// (all conditions false) — that path leaves with the parent's state, so
	// the parent's own facts join the intersection.
	{
		const contributors: Array<Set<string> | undefined> = [];
		switch_node.cases.forEach((switch_case, i) => {
			if (!block_always_returns(switch_case.branch)) {
				contributors.push(outer_scope_moved(branch_statuses[i], arms_base));
			}
		});
		if (switch_node.else_branch) {
			const else_bs = branch_statuses[switch_node.cases.length];
			if (else_bs && !block_always_returns(switch_node.else_branch)) {
				contributors.push(outer_scope_moved(else_bs, arms_base));
			}
		} else {
			contributors.push(status.moved_variables);
		}
		if (contributors.length > 0) {
			status.moved_variables = intersect_moved_variables(contributors);
		}
	}

	if (!switch_node.else_branch) {
		const parent = status.stack.at(-1);
		if (parent && (parent.node_type === "declare" || parent.node_type === "assign")) {
			add_error(status, "Switch expression must have an else branch", switch_node.start);
		}
	}
}
