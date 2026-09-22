import type BuildStatus from "../build_c/BuildStatus.ts";
import type { NirStmt } from "../nir/nir.ts";
import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import build_node from "./build_node.ts";
import { ensure_concurrency_runtime_a64 } from "./build_spawn_node.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
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
 * The pool helpers (__nomen_future_wait, __nomen_future_timedwait,
 * __nomen_future_release, __nomen_future_cancel) are C functions in the
 * companion file, called via `bl` from assembly.
 */
export default function build_async_block_node(
	node: AsyncBlockNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "async_block" },
) {
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	// The block's own join loop calls the future wait/cancel/release helpers
	// (and the race-mode helpers) unconditionally, so every nursery build
	// pulls the runtime in eagerly — the dependency is the emitted code's
	// own (ASYNC_PLAN phase 6).
	ensure_concurrency_runtime_a64(status);

	// Allocate per-invocation nursery state on this function's stack frame:
	// an 8-byte slot holding the growable futures list (NULL — the tracking
	// helper reallocs on the first registration; a fixed stack array once
	// capped the nursery at 64 spawns, and a heap pre-allocation cost 512 KB
	// per nursery, see FOLLOWUP.md), 8 bytes for the count, 8 for the
	// capacity, and (if the block names its nursery) 24 bytes for the Nursery
	// capability struct.
	const futures_off = allocate_stack_space(status, 8, 8);
	const count_off = allocate_stack_space(status, 8, 8);
	const cap_off = allocate_stack_space(status, 8, 8);
	emit_asm(status, `str xzr, [x29, #${count_off}]\n`); // count = 0
	emit_asm(status, `str xzr, [x29, #${cap_off}]\n`); // cap = 0
	emit_asm(status, `str xzr, [x29, #${futures_off}]\n`); // futures = NULL (grown on first registration)

	let nursery_off: number | undefined;
	if (node.nursery_name) {
		nursery_off = allocate_stack_space(status, 24, 8);
		// Build the Nursery capability struct pointing at this block's
		// tracking slots (the ADDRESS of the futures slot, so the escape
		// hatch's registration helper updates the list in place through a
		// realloc), so `ref name` / name.start can register spawned futures
		// with this nursery at runtime.
		emit_asm(status, `add x0, x29, #${futures_off}\n`);
		emit_asm(status, `str x0, [x29, #${nursery_off}]\n`); // futures_ptr
		emit_asm(status, `add x0, x29, #${count_off}\n`);
		emit_asm(status, `str x0, [x29, #${nursery_off + 8}]\n`); // count_ptr
		emit_asm(status, `add x0, x29, #${cap_off}\n`);
		emit_asm(status, `str x0, [x29, #${nursery_off + 16}]\n`); // cap_ptr
		// Register the name as a stack local so build_value_node /
		// emit_address_of resolve it like any other struct variable.
		if (!status.stack_offsets) status.stack_offsets = new Map();
		status.stack_offsets.set(node.nursery_name, nursery_off);
	}
	let deadline_off: number | undefined;
	if (node.timeout) {
		deadline_off = allocate_stack_space(status, 8, 8);
		// Sentinel: -1 means "no deadline computed yet".
		emit_asm(status, `mov x0, #-1\n`);
		emit_asm(status, `str x0, [x29, #${deadline_off}]\n`);
	}

	if (!status.nursery_offsets) status.nursery_offsets = new Map();
	status.nursery_offsets.set(id, { futures_off, count_off, cap_off, deadline_off });

	status.nursery_stack ??= [];
	status.nursery_stack.push(id);

	// Build the nursery body (spawns will look up offsets via nursery_stack).
	// The body is its own scope: give it a fresh scoped_declarations list (like
	// if/while/for/match/switch branches do) so its declarations are destroyed
	// ONCE, at the body's scope exit — otherwise they stay in the function's
	// list and the function-return cleanup destroys them a SECOND time, after
	// their memory was already reclaimed (use-after-free; flaky because the
	// freed block usually still holds the zeroed fields).
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];
	build_block_with_cursor(node, nir?.body, status);
	status.scoped_declarations = old_scoped_declarations;

	status.nursery_stack.pop();
	status.nursery_offsets.delete(id);

	// Emit join loop in assembly.
	emit_asm(status, `// nursery ${id}: join all futures\n`);
	emit_asm(status, `ldr x20, [x29, #${futures_off}]\n`); // x20 = futures (heap)
	emit_asm(status, `ldr w22, [x29, #${count_off}]\n`); // w22 = count

	// If timeout is specified, compute deadline before the join loop.
	if (deadline_off !== undefined) {
		emit_asm(status, `// Compute deadline: now + timeout_ms\n`);
		// Build the timeout expression first → x0, and save it across the
		// clock_gettime call. (Building it here in asm — not into a C helper —
		// because build_node emits assembly, not C.)
		build_node(node.timeout!, status);
		ensure_newline(status);
		emit_asm(status, `str x0, [sp, #-16]!\n`); // save timeout_ms
		emit_asm(status, `sub sp, sp, #16\n`);
		emit_asm(status, `mov x1, sp\n`); // timespec buffer
		emit_asm(status, `mov x0, #0\n`); // CLOCK_REALTIME
		emit_asm(status, `bl _clock_gettime\n`);
		emit_asm(status, `ldr x0, [sp]\n`); // tv_sec
		emit_asm(status, `ldr x1, [sp, #8]\n`); // tv_nsec
		emit_asm(status, `add sp, sp, #16\n`);
		emit_asm(status, `mov x2, #1000\n`);
		emit_asm(status, `mul x0, x0, x2\n`); // tv_sec * 1000
		// 1000000 doesn't fit in a single mov immediate; load from literal pool.
		emit_asm(status, `ldr x2, =1000000\n`);
		emit_asm(status, `udiv x1, x1, x2\n`); // tv_nsec / 1000000
		emit_asm(status, `add x0, x0, x1\n`); // now_ms
		emit_asm(status, `ldr x1, [sp], #16\n`); // restore timeout_ms
		emit_asm(status, `add x0, x1, x0\n`); // deadline = timeout + now
		emit_asm(status, `str x0, [x29, #${deadline_off}]\n`);
	}

	emit_asm(status, `mov x23, #0\n`); // x23 = i
	const loop_start = `__nursery_${id}_join_start`;
	const loop_end = `__nursery_${id}_join_end`;
	const loop_release = `__nursery_${id}_release`;

	const is_race = node.mode === "race";

	if (is_race) {
		// Race mode: poll until any future completes (or the deadline hits),
		// then fall through to the per-future cancel+wait+release loop.
		// __nomen_nursery_race_wait(futures_ptr, count, deadline_ms_or_0).
		emit_asm(status, `mov x0, x20\n`);
		emit_asm(status, `mov x1, x22\n`);
		if (deadline_off !== undefined) {
			emit_asm(status, `ldr x2, [x29, #${deadline_off}]\n`);
		} else {
			emit_asm(status, `mov x2, #0\n`);
		}
		emit_asm(status, `bl ___nomen_nursery_race_wait\n`);
	}

	emit_asm(status, `${loop_start}:\n`);
	emit_asm(status, `cmp x23, x22\n`);
	emit_asm(status, `b.ge ${loop_end}\n`);
	// Load futures[i] into x0.
	emit_asm(status, `ldr x0, [x20, x23, lsl #3]\n`);
	if (is_race) {
		// Cancel the task (no-op if already done), then wait for done
		// UNCONDITIONALLY — a bounded grace would release a future whose
		// task is still running and let the block exit free its resources
		// under it (memory corruption). A task that never observes
		// cancellation hangs the join: the documented kill-trampoline gap
		// (FOLLOWUP.md), not a soundness hole.
		emit_asm(status, `bl ___nomen_future_cancel\n`);
		emit_asm(status, `ldr x0, [x20, x23, lsl #3]\n`);
		emit_asm(status, `bl ___nomen_future_wait\n`);
	} else if (deadline_off !== undefined) {
		emit_asm(status, `ldr x1, [x29, #${deadline_off}]\n`);
		emit_asm(status, `bl ___nomen_future_timedwait\n`);
		// x0 = 1 if done, 0 if timed out.
		emit_asm(status, `cbnz x0, ${loop_release}\n`);
		// Timed out — cancel this task via the C helper (avoids hardcoding
		// the cancel_flag offset, which differs per platform), then wait
		// for done unconditionally (see the race note above).
		emit_asm(status, `ldr x0, [x20, x23, lsl #3]\n`); // reload future
		emit_asm(status, `bl ___nomen_future_cancel\n`);
		emit_asm(status, `ldr x0, [x20, x23, lsl #3]\n`);
		emit_asm(status, `bl ___nomen_future_wait\n`);
	} else {
		emit_asm(status, `bl ___nomen_future_wait\n`);
	}
	emit_asm(status, `${loop_release}:\n`);
	// Load future pointer again for release.
	emit_asm(status, `ldr x0, [x20, x23, lsl #3]\n`);
	emit_asm(status, `bl ___nomen_future_release\n`);
	emit_asm(status, `add x23, x23, #1\n`);
	emit_asm(status, `b ${loop_start}\n`);
	emit_asm(status, `${loop_end}:\n`);
	// Release the growable futures list (every registration happens before
	// the join completes); NULL when nothing was ever registered.
	emit_asm(status, `ldr x0, [x29, #${futures_off}]\n`);
	emit_asm(status, `cbz x0, __nursery_${id}_no_list\n`);
	emit_asm(status, `bl _free\n`);
	emit_asm(status, `__nursery_${id}_no_list:\n`);
}
