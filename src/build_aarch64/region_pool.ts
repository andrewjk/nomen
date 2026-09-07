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
import { CALLER_SAVED_EXT_X, region_pool_enabled } from "./utils/nir_regalloc.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";

export interface RegionLease {
	/** One borrowed register per pinned receiver (never shared: two
	 *  receivers on one register would alias their data pointers).
	 *  `had_claim` records a pre-existing extension-pool exclusion bit
	 *  (restored, not cleared, at exit). */
	leases: {
		reg: string;
		displaced: { name: string; slot: number; key: string }[];
		had_claim: boolean;
	}[];
}

/**
 * Whether a pin register bound in the live `register_allocations` map may
 * still borrow: every name currently bound to it must be proven dead
 * throughout this loop (the plan's per-pin dead-occupant keys, expanded
 * through the shared source-key table — a bound source name owns every key
 * it could be). Function-wide occupants are bound function-wide whether or
 * not they are live here, so a blanket bound check would refuse every
 * occupied register; emit-time promotion claims (loop inductions installed
 * as scopes open — invisible to the plan) own keys outside the dead set
 * and still refuse (the edigits receipt). Without the shared facts, refuse:
 * avoid-mode.
 */
function pin_borrowable(status: BuildStatus, pin: { reg: string; dead: string[] }): boolean {
	// An open bracket's pin is never re-borrowed by a nested loop: the two
	// brackets would round-trip through one home slot (or no slot), and the
	// inner exit would restore the outer pin value into the occupant's home
	// (or lose the outer pin entirely) — the outer resume then reads the
	// wrong value. Nested loops pin other registers or derive inline. The
	// same discipline covers region-scoped source variables (their register
	// holds the loop-local's live value for the whole bracket).
	if (status.region_pinned?.get(pin.reg)) return false;
	// Live pipeline/base homes from an outer loop's hoists are invisible to
	// the dead set (their names never enter register_allocations) yet live
	// across this loop — never borrow under one. Data-cache entries are
	// evicted below instead (the pointer re-derives on the next miss);
	// base homes have their own invalidation logic and must not be
	// disturbed, and neither may fixed-array pins.
	if (status.buffer_base_cache) {
		for (const v of status.buffer_base_cache.values()) {
			if (v.baseReg === pin.reg || v.dataReg === pin.reg) return false;
		}
	}
	if (status.array_ptr_cache) {
		for (const r of status.array_ptr_cache.values()) {
			if (r === pin.reg) return false;
		}
	}
	let bound = false;
	for (const [, reg] of status.register_allocations?.entries() ?? []) {
		if (reg === pin.reg) {
			bound = true;
			break;
		}
	}
	// Nothing bound: nothing to clobber (loop promotion installs its own
	// claims into this map as scopes open, so emit-time claims are visible
	// here too).
	if (!bound) return true;
	const shared = status.nir_alloc_shared;
	if (!shared) return false;
	const dead = new Set(pin.dead);
	for (const [name, reg] of status.register_allocations?.entries() ?? []) {
		if (reg !== pin.reg || name === undefined) continue;
		// Fast path: the bound name IS a dead plan occupant of this
		// register — its value is not needed in or across the loop, and
		// the bracket's spill/reload round-trips it. Sibling site keys of
		// the same source live on OTHER registers (any key on this
		// register would be an occupant, hence in the dead set — a pin is
		// only offered when every occupant is dead), so no expansion is
		// needed. Without this, the expansion below vetoes plain occupants
		// via same-source site keys elsewhere (the D4 receipt: x14 bound
		// to borrow1/sum/p_ll/p_val, all dead, refused over hi_prod@N on
		// no register near this loop).
		if (dead.has(name)) continue;
		const keys = shared.source_keys.get(name) ?? [name];
		for (const key of keys) {
			if (!dead.has(key)) return false;
		}
	}
	return true;
}

/**
 * Resolve every displaced occupant's frame slot for the bracket's
 * spill/reload round-trip: reuse one already registered, or PRE-ALLOCATE
 * (the tranche-D-addendum machinery — `preallocated_decl_slots` makes the
 * later declare reuse the exact slot; without the reuse the spill/reload
 * stays sound, just frame-wasteful).
 */
function resolve_displaced(
	status: BuildStatus,
	displaced: { name: string; key: string }[],
): { name: string; slot: number; key: string }[] {
	const resolved: { name: string; slot: number; key: string }[] = [];
	for (const d of displaced) {
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
	return resolved;
}

/**
 * Borrow a region-free pool register around `node`'s loop: emit the
 * displaced occupants' spills, derive each loop-invariant receiver's data
 * pointer into the register, and publish the cache pre-seed for the loop
 * builder. Region-scoped source variables (plan-assigned loop-contained
 * locals) borrow the remaining free registers the same way and publish
 * their `register_allocations` bindings through `region_preseed.vars` —
 * the loop builder installs them AFTER its snapshot, so its exit restore
 * drops the bindings with the bracket. Returns null when the plan has no
 * entry, the switch is off, a NEON/unroll plan already owns this loop's
 * emission, or no lease resolves.
 */
export function region_pool_enter(
	status: BuildStatus,
	node: BaseNode,
	has_transform_plan: boolean,
): RegionLease | null {
	if (!region_pool_enabled() || has_transform_plan) return null;
	const entry = status.nir_region_free?.get(node);
	if (!entry) return null;
	const has_pins = entry.pins.length > 0 && entry.receivers.length > 0;
	const has_vars = (entry.vars?.length ?? 0) > 0;
	if (!has_pins && !has_vars) return null;

	// A register bound at EMIT time (loop promotion claims install into
	// register_allocations as scopes open — the plan's occupant map can't
	// see them) is NOT borrowable: the plan-time disjointness proof covers
	// only plan-assigned occupants. The edigits receipt: the inner c-loop's
	// induction `c` was promoted into x24 by the outer loop's promotion,
	// and the bracket's digits.data derivation destroyed the induction.
	// Function-wide occupants stay bound in the map whether or not they are
	// live here — the per-pin dead set (not the bare binding) decides those.
	const n = Math.min(entry.pins.length, entry.receivers.length);
	const leases: RegionLease["leases"] = [];
	const entries: { key: string; reg: string }[] = [];
	for (let i = 0; i < n; i++) {
		const pin = entry.pins[i];
		const receiver = entry.receivers[i];
		const resolved = resolve_displaced(status, pin.displaced);
		const reg = pin.reg;
		if (!pin_borrowable(status, pin)) continue;
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
		let had_claim = false;
		if (CALLER_SAVED_EXT_X.includes(reg)) {
			// Extension-pool pins are caller-saved: no prologue save (the
			// entry spill + exit reload round-trips the displaced occupant
			// within the function). Exclusion rides
			// nir_caller_saved_claimed — the same split the buffer pipeline
			// uses for its x12–x15 hoists. A pre-existing bit is restored,
			// not cleared, at exit.
			if (!status.nir_caller_saved_claimed) status.nir_caller_saved_claimed = new Set();
			had_claim = status.nir_caller_saved_claimed.has(reg);
			status.nir_caller_saved_claimed.add(reg);
		} else {
			if (!status.callee_saved_regs_used) status.callee_saved_regs_used = new Set();
			status.callee_saved_regs_used.add(reg);
		}
		// Publish the active pin so loop promotion's sharing path refuses
		// it: the interference adjacency cannot see the pin, and sharing a
		// loop local onto it destroys one of them (the knucleotide
		// count_seq receipt). Reference-counted for nesting (an inner
		// bracket may borrow the same register — stack discipline restores
		// the outer pin at its exit — so the refusal lifts only when the
		// last bracket closes).
		if (!status.region_pinned) status.region_pinned = new Map();
		status.region_pinned.set(reg, (status.region_pinned.get(reg) ?? 0) + 1);
		emit_buffer_struct_addr(receiver.node, status);
		status.code += `ldr x9, [x9, #8]\n`;
		status.code += `mov ${reg}, x9\n`;
		entries.push({ key: receiver.key, reg });
		leases.push({ reg, displaced: resolved, had_claim });
	}
	// Region-scoped source variables: borrow their registers with the same
	// displaced-occupant round-trip and claim bookkeeping, and publish the
	// bindings for the loop builder to install after its snapshots (its
	// exit restores drop them — a register-bound loop local never leaks
	// past the bracket). Plain names go straight into
	// `register_allocations`; site-keyed vars install into
	// `nir_site_allocs` and bind at their declare sites. The var is
	// defined inside the loop and dead after it, so no entry load and no
	// exit store-back — only the displaced occupants' spill/reload frames
	// the borrow.
	const var_bindings: { name: string; reg: string; key?: string }[] = [];
	for (const v of entry.vars ?? []) {
		const resolved = resolve_displaced(status, v.displaced);
		if (!pin_borrowable(status, v)) continue;
		if (status.buffer_data_cache) {
			for (const [k, creg] of [...status.buffer_data_cache]) {
				if (creg === v.reg) status.buffer_data_cache.delete(k);
			}
		}
		for (const d of resolved) {
			status.code += `str ${v.reg}, [x29, #${d.slot}]\n`;
		}
		let had_claim = false;
		if (CALLER_SAVED_EXT_X.includes(v.reg)) {
			if (!status.nir_caller_saved_claimed) status.nir_caller_saved_claimed = new Set();
			had_claim = status.nir_caller_saved_claimed.has(v.reg);
			status.nir_caller_saved_claimed.add(v.reg);
		} else {
			if (!status.callee_saved_regs_used) status.callee_saved_regs_used = new Set();
			status.callee_saved_regs_used.add(v.reg);
		}
		if (!status.region_pinned) status.region_pinned = new Map();
		status.region_pinned.set(v.reg, (status.region_pinned.get(v.reg) ?? 0) + 1);
		var_bindings.push(
			v.key ? { name: v.name, reg: v.reg, key: v.key } : { name: v.name, reg: v.reg },
		);
		leases.push({ reg: v.reg, displaced: resolved, had_claim });
	}
	if (leases.length === 0) return null;
	status.region_preseed = { node, entries, vars: var_bindings };
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
		// The promotion-sharing refusal lifts when the last bracket holding
		// the register closes (nesting: an inner bracket borrowing the same
		// register decrements to the outer's count — the outer pin stays
		// protected).
		const depth = (status.region_pinned?.get(l.reg) ?? 1) - 1;
		if (depth <= 0) status.region_pinned?.delete(l.reg);
		else status.region_pinned?.set(l.reg, depth);
		// Extension-pool exclusion is bracket-scoped (unlike callee pins,
		// which must persist for the prologue patch): the pin is dead, the
		// displaced occupant restored, so later loops may use the register
		// again. A pre-existing bit is restored, not cleared.
		if (depth <= 0 && CALLER_SAVED_EXT_X.includes(l.reg) && !l.had_claim) {
			status.nir_caller_saved_claimed?.delete(l.reg);
		}
	}
	status.region_preseed = undefined;
}
