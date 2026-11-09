import add_error from "../add_error.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { persist_invalidated } from "./utils/borrow.ts";
import clone_status from "./utils/clone_status.ts";
import { apply_bounds, apply_negated_bounds } from "./utils/flow_bounds.ts";
import get_null_check_var from "./utils/get_null_check_var.ts";
import { outer_scope_moved, persist_moved_variables } from "./utils/moved_variables.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name, { is_bool_condition } from "./utils/type_name.ts";

export default function check_while_loop_node(while_loop: WhileLoopNode, status: CheckStatus) {
	// The enclosing scope's values length when the body clone is taken:
	// moved names whose innermost declaration sits at or beyond this index
	// are body-local (a fresh local or a shadow) and must not persist.
	const body_base = status.values.length;
	let while_status = clone_status(status);

	check_node(while_loop.condition, while_status);
	const condition_type = type_from_value_node(while_loop.condition, while_status);
	if (!is_bool_condition(condition_type)) {
		add_error(
			while_status,
			`While loop condition must be a bool, not ${type_name(condition_type)}`,
			while_loop.condition.start,
		);
	}

	// Narrow null state from condition into loop body (e.g. while thing != null)
	const null_check = get_null_check_var(while_loop.condition, while_status);
	if (null_check && !null_check.is_null_check) {
		// condition is thing != null — inside the loop, thing is not null.
		// findLast: the innermost declaration wins (mirrors the read path).
		const loop_var = while_status.values.findLast((v) => v.name === null_check.name);
		if (loop_var) loop_var.is_null = false;
		// Dotted bases (`while box.next != null`) are tracked by path.
		while_status.null_paths?.delete(null_check.name);
	}

	// Establish flow-sensitive bounds from condition (e.g. while j < list.length)
	apply_bounds(while_loop.condition, while_status, true);

	check_block_node(while_loop, while_status);

	if (while_loop.update) {
		check_node(while_loop.update, while_status);
	}

	// The body may have executed before the post-loop code, so invalidations
	// performed in it persist into the enclosing scope.
	persist_invalidated(status, while_status);

	// Moved-variable reconciliation: a move inside the body survives the
	// loop — the body may run before the post-loop code, so a name still
	// moved at the body's end joins the enclosing scope's moved set (a use
	// after the loop is rejected unless the body re-initializes it on the
	// iterations that run). A body-local re-initialization cannot un-move a
	// name the parent had moved (zero iterations leave it moved), so this is
	// a one-way union, never a copy-back — and body-local declarations
	// (shadows or fresh locals) never persist their moves.
	persist_moved_variables(status, outer_scope_moved(while_status, body_base));

	// After the loop exits, the negation of the condition is true
	// (e.g. `while idx >= cap` → after: idx < cap). Apply to parent scope.
	apply_negated_bounds(while_loop.condition, status);
}
