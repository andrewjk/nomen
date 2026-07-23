import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import { POOL_HEADER } from "./build_spawn_node.ts";
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
 * If a timeout is specified (`async(timeout: N) { ... }`), the join loop
 * uses timed waits. When the deadline expires, remaining tasks are cancelled
 * and the nursery exits.
 *
 * v1: fixed capacity (64 tasks per nursery). Exceeding it is undefined
 * behavior — a real implementation would grow or use a linked list.
 */
export default function build_async_block_node(node: AsyncBlockNode, status: BuildStatus) {
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	// In race mode the join loop references the cancel/timedwait/release
	// helpers (and the race_wait helper) directly. The pool header that
	// defines them is normally emitted on the first spawn — but a race
	// nursery with no spawns wouldn't otherwise pull it in. Emit the pool
	// header eagerly so the symbols always resolve.
	if (node.mode === "race" && !status.headers.includes("__nomen_pool_submit")) {
		status.headers += POOL_HEADER;
	}

	const futures_name = `__nomen_nursery_${id}_futures`;
	const count_name = `__nomen_nursery_${id}_count`;
	const idx_name = `__nomen_nursery_${id}_i`;

	status.code += `{\n`;
	status.code += `\tunsigned long long ${futures_name}[64];\n`;
	status.code += `\tint ${count_name} = 0;\n`;
	// Declare the user-named Nursery capability (if any) pointing at this
	// block's futures array + count slot, so the escape hatch (`ref name` /
	// `name.spawn(...)`) can register spawned futures with this nursery.
	if (node.nursery_name) {
		status.code += `\tstruct Nursery ${node.nursery_name};\n`;
		status.code += `\t${node.nursery_name}.futures_ptr = (unsigned long long)${futures_name};\n`;
		status.code += `\t${node.nursery_name}.count_ptr = (unsigned long long)&${count_name};\n`;
	}

	// If timeout is specified, compute deadline (absolute ms since epoch).
	let deadline_var = "";
	if (node.timeout) {
		deadline_var = `_deadline_ms_${id}`;
		status.code += `\tlong long ${deadline_var};\n`;
		status.code += `\t{\n`;
		status.code += `\t\tstruct timespec _ts;\n`;
		status.code += `\t\tclock_gettime(CLOCK_REALTIME, &_ts);\n`;
		status.code += `\t\tlong long _now_ms = (long long)_ts.tv_sec * 1000 + _ts.tv_nsec / 1000000;\n`;
		status.code += `\t\t${deadline_var} = _now_ms + (long long)`;
		build_node(node.timeout, status);
		status.code += `;\n`;
		status.code += `\t}\n`;
	}

	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = enter_c_scope(status);
	const old_deferred_frees = status.deferred_frees;
	status.deferred_frees = [];

	status.nursery_stack ??= [];
	status.nursery_stack.push(id);

	build_block_node(node, status);

	status.nursery_stack.pop();

	const is_race = node.mode === "race";

	if (is_race) {
		// Race mode: wait until any future completes (or the deadline hits),
		// then cancel the remaining tasks, then join + release every future
		// (the join is a no-op for tasks already finished; cancelled tasks
		// get a brief grace period via the deadline-extended wait below).
		status.code += `\t__nomen_nursery_race_wait((struct nomen_future **)${futures_name}, ${count_name}, ${deadline_var ? deadline_var : "0"});\n`;
	}
	status.code += `\tfor (int ${idx_name} = 0; ${idx_name} < ${count_name}; ${idx_name}++) {\n`;
	status.code += `\t\tstruct nomen_future *_f = (struct nomen_future *)${futures_name}[${idx_name}];\n`;
	if (is_race) {
		// Cancel anything still running, then wait+release with a generous
		// extended deadline so cancelled tasks actually exit before release.
		status.code += `\t\t__nomen_future_cancel(_f);\n`;
		status.code += `\t\t__nomen_future_timedwait(_f, ${deadline_var ? deadline_var : "0"} + 1000);\n`;
	} else if (deadline_var) {
		status.code += `\t\tint _done = __nomen_future_timedwait(_f, ${deadline_var});\n`;
		status.code += `\t\tif (!_done) {\n`;
		// Timeout expired — cancel this task and any remaining tasks.
		status.code += `\t\t\tif (_f->cancel_flag) *(_f->cancel_flag) = 1;\n`;
		status.code += `\t\t\t__nomen_future_timedwait(_f, ${deadline_var} + 1000);\n`;
		status.code += `\t\t}\n`;
	} else {
		status.code += `\t\t__nomen_future_wait(_f);\n`;
	}
	status.code += `\t\t__nomen_future_release(_f);\n`;
	status.code += `\t}\n`;

	build_auto_free(status);

	status.code += `}\n`;

	leave_c_scope(status);
	status.scoped_declarations = old_scoped_declarations;
	status.deferred_frees = old_deferred_frees;
}
