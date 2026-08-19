import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import build_condition from "./utils/build_condition.ts";
import {
	enter_c_scope,
	leave_c_scope,
	pop_c_loop_frame,
	push_c_loop_frame,
} from "./utils/c_scope.ts";
import emit_allocations from "./utils/emit_allocations.ts";

export default function build_while_loop_node(node: WhileLoopNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = enter_c_scope(status);
	const old_deferred_frees = status.deferred_frees;
	status.deferred_frees = [];
	push_c_loop_frame(status);

	// Hoist allocation declarations from the condition to before the `while`.
	emit_allocations(node.condition, status);

	// When there's an update clause (e.g. `while n <= 20; n += 1`), emit a
	// C `for` loop so that `continue` inside the body still runs the update
	// before re-checking the condition — matching the language's semantics.
	if (node.update) {
		status.code += `for (; `;
		build_condition(node.condition, status);
		status.code += `; `;
		build_node(node.update, status);
		status.code += `) {\n`;
	} else {
		status.code += `while (`;
		build_condition(node.condition, status);
		status.code += `) {\n`;
	}

	build_block_node(node, status);

	build_auto_free(status);

	status.code += `}\n`;

	pop_c_loop_frame(status);
	leave_c_scope(status);
	status.scoped_declarations = old_scoped_declarations;
	status.deferred_frees = old_deferred_frees;
}
