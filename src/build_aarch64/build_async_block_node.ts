import type BuildStatus from "../build_c/BuildStatus.ts";
import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import build_block_node from "./build_block_node.ts";

/**
 * Build an `async { ... }` nursery block for aarch64.
 *
 * Allocates a 64-element futures array on the stack. Spawns inside the block
 * push their future pointer to the array (tracked via status.nursery_stack).
 * At block exit, the nursery waits on every future, then releases its reference.
 *
 * The pool helpers (__echo_future_wait, __echo_future_release) are C functions
 * in the companion file, so we call them via `bl` from assembly.
 */
export default function build_async_block_node(node: AsyncBlockNode, status: BuildStatus) {
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	const futures_name = `__echo_nursery_${id}_futures`;
	const count_name = `__echo_nursery_${id}_count`;

	// Emit file-scope declarations for the futures array and count.
	// These must be global symbols so the spawn trampolines (in the companion C)
	// and the join loop (in assembly) can both reference them.
	if (!status.file_scope_c) status.file_scope_c = "";
	status.file_scope_c += `unsigned long long ${futures_name}[64];\n`;
	status.file_scope_c += `int ${count_name} = 0;\n`;

	status.nursery_stack ??= [];
	status.nursery_stack.push(id);

	// Build the nursery body (spawns will push to the nursery arrays).
	build_block_node(node, status);

	status.nursery_stack.pop();

	// Emit join loop in assembly: iterate futures array, call
	// __echo_future_wait and __echo_future_release on each.
	status.code += `// nursery ${id}: join all futures\n`;
	// Load array base address into x20, count into x21.
	status.code += `adrp x20, _${futures_name}@PAGE\n`;
	status.code += `add x20, x20, _${futures_name}@PAGEOFF\n`;
	status.code += `adrp x21, _${count_name}@PAGE\n`;
	status.code += `add x21, x21, _${count_name}@PAGEOFF\n`;
	status.code += `ldr w22, [x21]\n`; // w22 = count
	// Loop index in x19 (but x19 is self... use x23).
	status.code += `mov x23, #0\n`; // x23 = i
	const loop_start = `__nursery_${id}_join_start`;
	const loop_end = `__nursery_${id}_join_end`;
	status.code += `${loop_start}:\n`;
	status.code += `cmp x23, x22\n`;
	status.code += `b.ge ${loop_end}\n`;
	// Load futures[i] into x0.
	status.code += `ldr x0, [x20, x23, lsl #3]\n`;
	// Call __echo_future_wait(future).
	status.code += `bl ___echo_future_wait\n`;
	// Load future pointer again (x0 may have been clobbered).
	status.code += `ldr x0, [x20, x23, lsl #3]\n`;
	// Call __echo_future_release(future).
	status.code += `bl ___echo_future_release\n`;
	status.code += `add x23, x23, #1\n`;
	status.code += `b ${loop_start}\n`;
	status.code += `${loop_end}:\n`;
	// Reset count.
	status.code += `str wzr, [x21]\n`;
}
