/**
 * Region-scoped pool claims (ASM_PLAN_5 tranche 1): loop-scoped Buffer
 * data-pointer materialization.
 *
 * The plan (nir_regalloc.ts) computes, per NIR loop, the callee-pool
 * registers whose function-wide occupants are dead throughout the loop's
 * blocks. The while-dispatch bracket borrows one around the loop body:
 *
 * - the displaced occupants are spilled to their frame slots at entry and
 *   reloaded at exit (their slots may be stale before the spill — the
 *   register is the current value — so the spill makes the round-trip
 *   coherent);
 * - the loop's loop-invariant Buffer receiver paths (plan-collected: the
 *   receiver root is never written or ref-arg'd inside the loop, and the
 *   loop contains no real call that could reallocate) are derived BEFORE
 *   the loop header into the borrowed register, and `buffer_data_cache`
 *   is pre-seeded (via `status.region_preseed`, which the loop builder
 *   applies after its own snapshot-clear) — so every in-loop accessor
 *   derivation emits nothing and the pointer is materialized once per
 *   LOOP, not once per iteration.
 *
 * Soundness: the register is in `callee_saved_regs_used` for the whole
 * bracket, so every claimant (loop promotion, staging pins, tree pools,
 * inline expansions) refuses it; occupant liveness disjointness is from
 * the same renamed CFG the allocator assigned with; and the pre-seeded
 * cache keys die with the bracket (the builder's cache is a body-local
 * object, discarded at its exit). Nested loops re-snapshot: an inner loop
 * without its own plan misses and derives inline (today's behavior).
 *
 * Kill-switch: `set_region_pool_enabled(false)` (shared with the planner)
 * makes `region_pool_enter` return null — byte-identical output.
 */

import type BuildStatus from "../build_c/BuildStatus.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import { emit_buffer_struct_addr } from "./build_access_node.ts";
import { region_pool_enabled } from "./utils/nir_regalloc.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";

export interface RegionLease {
	/** One borrowed register per pinned receiver (never shared: two
	 *  receivers on one register would alias their data pointers). */
	leases: { reg: string; displaced: { name: string; slot: number; key: string }[] }[];
}

/**
 * Borrow a region-free pool register around `node`'s loop: emit the
 * displaced occupants' spills, derive each loop-invariant receiver's data
 * pointer into the register, and publish the cache pre-seed for the loop
 * builder. Returns null when the plan has no entry, the switch is off, a
 * NEON/unroll plan already owns this loop's emission, or no displaced
 * slot resolves.
 */
export function region_pool_enter(
	status: BuildStatus,
	node: BaseNode,
	has_transform_plan: boolean,
): RegionLease | null {
	if (!region_pool_enabled() || has_transform_plan) return null;
	const entry = status.nir_region_free?.get(node);
	if (!entry || entry.pins.length === 0 || entry.receivers.length === 0) return null;

	const n = Math.min(entry.pins.length, entry.receivers.length);
	const leases: RegionLease["leases"] = [];
	const entries: { key: string; reg: string }[] = [];
	for (let i = 0; i < n; i++) {
		const pin = entry.pins[i];
		const receiver = entry.receivers[i];
		// Every displaced occupant needs a frame slot: reuse one already
		// registered, or PRE-ALLOCATE (the tranche-D-addendum machinery —
		// `preallocated_decl_slots` makes the later declare reuse the exact
		// slot; without the reuse the spill/reload stays sound, just
		// frame-wasteful).
		const resolved: { name: string; slot: number; key: string }[] = [];
		let ok = true;
		for (const d of pin.displaced) {
			let slot = status.stack_offsets?.get(d.name);
			if (slot === undefined) {
				if (!status.stack_offsets) status.stack_offsets = new Map();
				slot = allocate_stack_space(status, 8, 8);
				status.stack_offsets.set(d.name, slot);
				if (!status.preallocated_decl_slots) status.preallocated_decl_slots = new Map();
				status.preallocated_decl_slots.set(d.name, 8);
			}
			resolved.push({ name: d.name, slot, key: d.key });
		}
		if (!ok) continue;
		const reg = pin.reg;
		// The register must not already hold a cache entry (function-wide
		// claims were checked at plan time; emission-time claims are
		// evicted — the pointer is re-derived on the next miss).
		if (status.buffer_data_cache) {
			for (const [k, v] of [...status.buffer_data_cache]) {
				if (v === reg) status.buffer_data_cache.delete(k);
			}
		}
		for (const d of resolved) {
			status.code += `str ${reg}, [x29, #${d.slot}]\n`;
		}
		if (!status.callee_saved_regs_used) status.callee_saved_regs_used = new Set();
		status.callee_saved_regs_used.add(reg);
		emit_buffer_struct_addr(receiver.node, status);
		status.code += `ldr x9, [x9, #8]\n`;
		status.code += `mov ${reg}, x9\n`;
		if (process.env.NOMEN_REGION_NOSEED !== "1") entries.push({ key: receiver.key, reg });
		leases.push({ reg, displaced: resolved });
	}
	if (leases.length === 0) return null;
	status.region_preseed = { node, entries };
	return { leases };
}

/**
 * Close the lease: the loop builder's exit already restored its own cache
 * snapshot (the pre-seeded entries were body-local and discarded with it),
 * so only the displaced occupants' reloads and the claim bookkeeping
 * remain.
 */
export function region_pool_exit(status: BuildStatus, lease: RegionLease | null): void {
	if (!lease) return;
	for (const l of lease.leases) {
		// The pin STAYS in callee_saved_regs_used: the plan claims it
		// function-wide (plan.callee_saved → the prologue/epilogue
		// save/restore patch), so deleting it here would drop it from the
		// post-body patch and the function would destroy the CALLER's
		// value in that register (the layout corruption receipt).
		for (const d of l.displaced) {
			status.code += `ldr ${l.reg}, [x29, #${d.slot}]\n`;
		}
	}
	status.region_preseed = undefined;
}
