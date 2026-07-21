import type BuildStatus from "../build_c/BuildStatus.ts";
import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";

/**
 * Build an `async { ... }` nursery block for aarch64.
 *
 * Allocates a 64-element futures array and a count slot ON THE CALLER'S STACK
 * (per-invocation), so concurrent nursery invocations — including the same
 * async block running in parallel spawned tasks — get independent state.
 * Spawns inside the block pass the array/count addresses to the C submit
 * helper, which writes the future pointer and bumps the count.
 *
 * At block exit, the nursery waits on every future, then releases its
 * reference. If a timeout is specified (`async(timeout: N) { ... }`), the
 * join loop uses timed waits; when the deadline expires, remaining tasks are
 * cancelled.
 *
 * The pool helpers (__echo_future_wait, __echo_future_timedwait,
 * __echo_future_release, __echo_future_cancel) are C functions in the
 * companion file, called via `bl` from assembly.
 */
export default function build_async_block_node(node: AsyncBlockNode, status: BuildStatus) {
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	// Allocate per-invocation nursery state on this function's stack frame.
	// 64 futures × 8 bytes = 512 bytes for the array, 8 bytes for the count,
	// and (if timeout) 8 bytes for the deadline.
	const futures_off = allocate_stack_space(status, 512, 16);
	const count_off = allocate_stack_space(status, 8, 8);
	status.code += `str xzr, [x29, #${count_off}]\n`; // count = 0
	let deadline_off: number | undefined;
	if (node.timeout) {
		deadline_off = allocate_stack_space(status, 8, 8);
		// Sentinel: -1 means "no deadline computed yet".
		status.code += `mov x0, #-1\n`;
		status.code += `str x0, [x29, #${deadline_off}]\n`;
	}

	if (!status.nursery_offsets) status.nursery_offsets = new Map();
	status.nursery_offsets.set(id, { futures_off, count_off, deadline_off });

	status.nursery_stack ??= [];
	status.nursery_stack.push(id);

	// Build the nursery body (spawns will look up offsets via nursery_stack).
	build_block_node(node, status);

	status.nursery_stack.pop();
	status.nursery_offsets.delete(id);

	// Emit join loop in assembly.
	status.code += `// nursery ${id}: join all futures\n`;
	status.code += `add x20, x29, #${futures_off}\n`; // x20 = &futures[0]
	status.code += `ldr w22, [x29, #${count_off}]\n`; // w22 = count

	// If timeout is specified, compute deadline before the join loop.
	if (deadline_off !== undefined) {
		status.code += `// Compute deadline: now + timeout_ms\n`;
		// Build the timeout expression first → x0, and save it across the
		// clock_gettime call. (Building it here in asm — not into a C helper —
		// because build_node emits assembly, not C.)
		build_node(node.timeout!, status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `str x0, [sp, #-16]!\n`; // save timeout_ms
		status.code += `sub sp, sp, #16\n`;
		status.code += `mov x1, sp\n`; // timespec buffer
		status.code += `mov x0, #0\n`; // CLOCK_REALTIME
		status.code += `bl _clock_gettime\n`;
		status.code += `ldr x0, [sp]\n`; // tv_sec
		status.code += `ldr x1, [sp, #8]\n`; // tv_nsec
		status.code += `add sp, sp, #16\n`;
		status.code += `mov x2, #1000\n`;
		status.code += `mul x0, x0, x2\n`; // tv_sec * 1000
		// 1000000 doesn't fit in a single mov immediate; load from literal pool.
		status.code += `ldr x2, =1000000\n`;
		status.code += `udiv x1, x1, x2\n`; // tv_nsec / 1000000
		status.code += `add x0, x0, x1\n`; // now_ms
		status.code += `ldr x1, [sp], #16\n`; // restore timeout_ms
		status.code += `add x0, x1, x0\n`; // deadline = timeout + now
		status.code += `str x0, [x29, #${deadline_off}]\n`;
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
	if (deadline_off !== undefined) {
		status.code += `ldr x1, [x29, #${deadline_off}]\n`;
		status.code += `bl ___echo_future_timedwait\n`;
		// x0 = 1 if done, 0 if timed out.
		status.code += `cbnz x0, ${loop_release}\n`;
		// Timed out — cancel this task via the C helper (avoids hardcoding
		// the cancel_flag offset, which differs per platform), then wait
		// once more (with an extended deadline) so the task actually gets
		// to observe the flag and exit before the nursery tears down.
		status.code += `ldr x0, [x20, x23, lsl #3]\n`; // reload future
		status.code += `bl ___echo_future_cancel\n`;
		status.code += `ldr x0, [x20, x23, lsl #3]\n`;
		status.code += `ldr x1, [x29, #${deadline_off}]\n`;
		status.code += `add x1, x1, #1000\n`; // extend deadline by 1s
		status.code += `bl ___echo_future_timedwait\n`;
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
}
