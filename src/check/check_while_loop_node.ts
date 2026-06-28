import add_error from "../add_error.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import clone_status from "./utils/clone_status.ts";
import { apply_bounds, apply_negated_bounds } from "./utils/flow_bounds.ts";
import get_null_check_var from "./utils/get_null_check_var.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";

export default function check_while_loop_node(while_loop: WhileLoopNode, status: CheckStatus) {
	let while_status = clone_status(status);

	check_node(while_loop.condition, while_status);
	const condition_type = type_from_value_node(while_loop.condition, while_status);
	if (type_name(condition_type) !== "bool") {
		add_error(
			while_status,
			`While loop condition must be a bool, not ${type_name(condition_type)}`,
			while_loop.condition.start,
		);
	}

	// Narrow null state from condition into loop body (e.g. while thing != null)
	const null_check = get_null_check_var(while_loop.condition);
	if (null_check && !null_check.is_null_check) {
		// condition is thing != null — inside the loop, thing is not null
		const loop_var = while_status.values.find((v) => v.name === null_check.name);
		if (loop_var) loop_var.is_null = false;
	}

	// Establish flow-sensitive bounds from condition (e.g. while j < list.length)
	apply_bounds(while_loop.condition, while_status);

	check_block_node(while_loop, while_status);

	if (while_loop.update) {
		check_node(while_loop.update, while_status);
	}

	// After the loop exits, the negation of the condition is true
	// (e.g. `while idx >= cap` → after: idx < cap). Apply to parent scope.
	apply_negated_bounds(while_loop.condition, status);
}
