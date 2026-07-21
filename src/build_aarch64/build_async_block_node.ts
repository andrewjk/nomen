import build_node from "../build_c/build_node.ts";
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
 * If a timeout is specified (`async(timeout: N) { ... }`), the deadline is
 * computed before the block body and the join loop uses timed waits. When
 * the deadline expires, remaining tasks are cancelled.
 *
 * The pool helpers (__echo_future_wait, __echo_future_timedwait,
 * __echo_future_release) are C functions in the companion file, so we call
 * them via `bl` from assembly.
 */
export default function build_async_block_node(node: AsyncBlockNode, status: BuildStatus) {
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	const futures_name = `__echo_nursery_${id}_futures`;
	const count_name = `__echo_nursery_${id}_count`;

	// Emit file-scope declarations for the futures array and count.
	if (!status.file_scope_c) status.file_scope_c = "";
	status.file_scope_c += `unsigned long long ${futures_name}[64];\n`;
	status.file_scope_c += `int ${count_name} = 0;\n`;

	// If timeout is specified, declare a file-scope deadline variable.
	let deadline_sym = "";
	if (node.timeout) {
		deadline_sym = `__echo_nursery_${id}_deadline`;
		status.file_scope_c += `long long ${deadline_sym} = -1;\n`;
	}

	status.nursery_stack ??= [];
	status.nursery_stack.push(id);

	// Build the nursery body (spawns will push to the nursery arrays).
	build_block_node(node, status);

	status.nursery_stack.pop();

	// Emit join loop in assembly.
	status.code += `// nursery ${id}: join all futures\n`;
	// Load array base address into x20, count into x21.
	status.code += `adrp x20, _${futures_name}@PAGE\n`;
	status.code += `add x20, x20, _${futures_name}@PAGEOFF\n`;
	status.code += `adrp x21, _${count_name}@PAGE\n`;
	status.code += `add x21, x21, _${count_name}@PAGEOFF\n`;
	status.code += `ldr w22, [x21]\n`; // w22 = count

	// If timeout is specified, compute deadline before the join loop.
	if (deadline_sym) {
		status.code += `// Compute deadline: now + timeout_ms\n`;
		status.code += `sub sp, sp, #16\n`;
		status.code += `mov x0, sp\n`;
		status.code += `bl _clock_gettime\n`;
		status.code += `ldr x0, [sp]\n`; // tv_sec
		status.code += `ldr x1, [sp, #8]\n`; // tv_nsec
		status.code += `add sp, sp, #16\n`;
		status.code += `mov x2, #1000\n`;
		status.code += `mul x0, x0, x2\n`; // tv_sec * 1000
		status.code += `mov x2, #1000000\n`;
		status.code += `udiv x1, x1, x2\n`; // tv_nsec / 1000000
		status.code += `add x0, x0, x1\n`; // now_ms
		// Emit a C helper that returns the timeout expression value.
		const timeout_fn = `__echo_nursery_${id}_timeout_ms`;
		status.file_scope_c += `long long ${timeout_fn}(void) { return (long long)`;
		build_node(node.timeout!, status);
		status.file_scope_c += `; }\n`;
		status.code += `str x0, [sp, #-16]!\n`; // save now_ms
		status.code += `bl _${timeout_fn}\n`; // x0 = timeout_ms
		status.code += `ldr x1, [sp], #16\n`; // restore now_ms
		status.code += `add x0, x1, x0\n`; // deadline = now + timeout
		// Store deadline to file-scope global.
		status.code += `adrp x1, _${deadline_sym}@PAGE\n`;
		status.code += `add x1, x1, _${deadline_sym}@PAGEOFF\n`;
		status.code += `str x0, [x1]\n`;
	}

	status.code += `mov x23, #0\n`; // x23 = i
	const loop_start = `__nursery_${id}_join_start`;
	const loop_end = `__nursery_${id}_join_end`;
	const loop_release = `__nursery_${id}_release`;
	status.code += `${loop_start}:\n`;
	status.code += `cmp x23, x22\n`;
	status.code += `b.ge ${loop_end}\n`;
	// Load futures[i] into x0.
	status.code += `ldr x0, [x20, x23, lsl #3]\n`;
	if (deadline_sym) {
		// Load deadline into x1 for timed wait.
		status.code += `adrp x1, _${deadline_sym}@PAGE\n`;
		status.code += `add x1, x1, _${deadline_sym}@PAGEOFF\n`;
		status.code += `ldr x1, [x1]\n`;
		status.code += `bl ___echo_future_timedwait\n`;
		// x0 = 1 if done, 0 if timed out.
		status.code += `cbnz x0, ${loop_release}\n`;
		// Timed out — cancel this task.
		status.code += `ldr x0, [x20, x23, lsl #3]\n`; // reload future
		status.code += `ldr x1, [x0, #40]\n`; // cancel_flag offset
		status.code += `cbz x1, ${loop_release}\n`;
		status.code += `mov x2, #1\n`;
		status.code += `str x2, [x1]\n`; // *cancel_flag = 1
	} else {
		status.code += `bl ___echo_future_wait\n`;
	}
	status.code += `${loop_release}:\n`;
	// Load future pointer again for release.
	status.code += `ldr x0, [x20, x23, lsl #3]\n`;
	status.code += `bl ___echo_future_release\n`;
	status.code += `add x23, x23, #1\n`;
	status.code += `b ${loop_start}\n`;
	status.code += `${loop_end}:\n`;
	// Reset count.
	status.code += `str wzr, [x21]\n`;
}
