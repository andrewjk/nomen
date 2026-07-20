import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_block_node from "./build_block_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { enter_c_scope, leave_c_scope } from "./utils/c_scope.ts";

/**
 * Build an `async { ... }` nursery block.
 *
 * Emits a scope with a fixed-capacity future-pointer array. Spawns inside
 * the block (detected via status.nursery_stack) push their future pointer
 * to the array and take a future reference for the nursery. At block exit,
 * the nursery waits on every future, then releases its reference (waiting
 * is idempotent, so a Task the user already waited on joins instantly).
 *
 * The join runs BEFORE block-scoped locals are destroyed: a still-running
 * task may hold pointers into those locals (e.g. a Channel declared in the
 * nursery), so they must stay alive until every task has finished.
 *
 * v1: fixed capacity (64 tasks per nursery). Exceeding it is undefined
 * behavior — a real implementation would grow or use a linked list.
 */
export default function build_async_block_node(node: AsyncBlockNode, status: BuildStatus) {
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	const futures_name = `__echo_nursery_${id}_futures`;
	const count_name = `__echo_nursery_${id}_count`;
	const idx_name = `__echo_nursery_${id}_i`;

	status.code += `{\n`;
	status.code += `\tunsigned long long ${futures_name}[64];\n`;
	status.code += `\tint ${count_name} = 0;\n`;

	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = enter_c_scope(status);
	const old_deferred_frees = status.deferred_frees;
	status.deferred_frees = [];

	status.nursery_stack ??= [];
	status.nursery_stack.push(id);

	build_block_node(node, status);

	status.nursery_stack.pop();

	status.code += `\tfor (int ${idx_name} = 0; ${idx_name} < ${count_name}; ${idx_name}++) {\n`;
	status.code += `\t\tstruct echo_future *_f = (struct echo_future *)${futures_name}[${idx_name}];\n`;
	status.code += `\t\t__echo_future_wait(_f);\n`;
	status.code += `\t\t__echo_future_release(_f);\n`;
	status.code += `\t}\n`;

	build_auto_free(status);

	status.code += `}\n`;

	leave_c_scope(status);
	status.scoped_declarations = old_scoped_declarations;
	status.deferred_frees = old_deferred_frees;
}
