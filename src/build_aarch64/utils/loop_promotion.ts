import type BuildStatus from "../../build_c/BuildStatus.ts";
import { ALL_FLOAT_TYPES, SCALAR_TYPES } from "../../built_in_types.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import aarch64_size from "./aarch64_size.ts";
import collect_var_refs from "./collect_var_refs.ts";
import { allocate_stack_space, emit_promoted_load } from "./stack_var.ts";

/**
 * Shared per-loop register promotion (ASM_PLAN phase 4).
 *
 * This is the promotion core that used to live duplicated inline in
 * build_while_loop_node and build_for_loop_node (~110 identical lines each):
 * scan the loop's condition/body/update for variable traffic, and reserve
 * callee-saved registers for the hottest scalar locals (reads >= 3, never
 * address-taken, never redeclared in the loop body, not already claimed by
 * the whole-function allocator). Each promotion emits its width-aware
 * `emit_promoted_load` immediately (loop-entry cache fill) and the caller is
 * responsible for the loop-exit `emit_promoted_store` write-backs plus the
 * `register_allocations` snapshot/restore.
 *
 * Register-class bookkeeping is split by pool: a d-register claimed by an
 * enclosing loop's promotion or a Buffer data-pointer cache must block the
 * FLOAT pool, not just the x pool.
 */

const CALLEE_SAVED_REGS = ["x23", "x24", "x25", "x26", "x27", "x28"];
const FLOAT_CALLEE_SAVED = ["d8", "d9", "d10", "d11", "d12", "d13", "d14", "d15"];
// Caller-saved extension pool (ASM_PLAN_2 tranche D addendum): for
// CALL-FREE loop bodies nothing can clobber v24-v31 mid-loop, so hot
// locals may live there with no prologue saves. Distinct from the tree
// allocator's d16-d23 temps (no overlap).
const FLOAT_CALLER_SAVED_EXT = ["d24", "d25", "d26", "d27", "d28", "d29", "d30", "d31"];
// Int caller-saved extension pool (ASM_PLAN_2 tranche F): same contract
// as FLOAT_CALLER_SAVED_EXT — call-free loop bodies only, values synced
// to their home slots by the loop-exit store-backs. x10/x11 stay
// excluded (write-barrier address math), x12-x15 are additionally
// clobbered by the NEON vector loop, so the caller gates this pool off
// when a vector plan rides. x9 is the emitter's address scratch.
const INT_CALLER_SAVED_EXT = ["x12", "x13", "x14", "x15"];

export interface PromotedVar {
	name: string;
	reg: string;
	offset: number;
	type_name: string;
}

/**
 * Value-node names assigned in this statement subtree (`x = …`, `x += …`,
 * `obj.f = …` assigns the object root's field — the ROOT name counts as a
 * write for promotion purposes only when it's a plain value target).
 */
function collect_assign_targets(node: BaseNode, out: Set<string>): void {
	if (!node || typeof node !== "object") return;
	const n = node as unknown as Record<string, unknown>;
	if (n.node_type === "assign" || n.node_type === "assign_decl") {
		const left = n.left_value as BaseNode | undefined;
		if (left && left.node_type === "value") {
			const v = (left as unknown as { value: string }).value;
			if (v && v !== "null" && !v.startsWith('"')) out.add(v);
		}
	}
	for (const key of Object.keys(n)) {
		if (key === "parent" || key === "scope") continue;
		const v = n[key];
		if (Array.isArray(v)) {
			for (const item of v) {
				if (item && typeof item === "object" && "node_type" in (item as object)) {
					collect_assign_targets(item as BaseNode, out);
				}
			}
		} else if (v && typeof v === "object" && "node_type" in (v as object)) {
			collect_assign_targets(v as BaseNode, out);
		}
	}
}

/**
 * Promote the loop's hottest variables and emit their entry loads. Mutates
 * `status.register_allocations` (creating the map when absent) and seeds
 * `status.callee_saved_regs_used` with every claimed register. Returns the
 * promoted bindings in promotion order — the caller emits the matching
 * store-backs at loop exit.
 */
export function promote_loop_locals(
	status: BuildStatus,
	scoped_declarations: DeclarationNode[],
	sources: { condition?: BaseNode; statements: BaseNode[]; update?: BaseNode | null },
	options?: { call_free?: boolean; int_ext?: boolean },
): PromotedVar[] {
	const promoted: PromotedVar[] = [];
	const all_refs = new Map<string, { reads: number; address_taken: boolean }>();

	const merge_refs = (refs: Map<string, { reads: number; address_taken: boolean }>) => {
		for (const [name, info] of refs) {
			const existing = all_refs.get(name);
			if (existing) {
				existing.reads += info.reads;
				if (info.address_taken) existing.address_taken = true;
			} else {
				all_refs.set(name, {
					reads: info.reads,
					address_taken: info.address_taken,
				});
			}
		}
	};

	if (sources.condition) {
		merge_refs(collect_var_refs(sources.condition));
	}
	for (const stmt of sources.statements) {
		merge_refs(collect_var_refs(stmt));
	}
	if (sources.update) {
		merge_refs(collect_var_refs(sources.update));
	}

	const eligible: {
		name: string;
		reads: number;
		offset: number;
		type_name: string;
	}[] = [];
	// Body-declared names are promotable when declared exactly ONCE (the
	// accumulator/const-local pattern: `var a = 0.0` / `const float bj_x =
	// …` — the slot write executes per iteration and reads should come
	// from the register). Declared twice = redeclared → two slots, one
	// register: unsound, keep excluded.
	const body_decl_count = new Map<string, number>();
	const body_decl_type = new Map<string, string>();
	{
		const count_declares = (node: BaseNode): void => {
			if (!node || typeof node !== "object") return;
			const n = node as unknown as Record<string, unknown>;
			if (n.node_type === "declare") {
				const dn = n as unknown as { name?: string; type?: { name?: string } };
				if (dn.name) {
					body_decl_count.set(dn.name, (body_decl_count.get(dn.name) ?? 0) + 1);
					if (!body_decl_type.has(dn.name)) body_decl_type.set(dn.name, dn.type?.name ?? "");
				}
			}
			for (const key of Object.keys(n)) {
				if (key === "parent" || key === "scope") continue;
				const v = n[key];
				if (Array.isArray(v)) {
					for (const item of v) {
						if (item && typeof item === "object" && "node_type" in (item as object)) {
							count_declares(item as BaseNode);
						}
					}
				} else if (v && typeof v === "object" && "node_type" in (v as object)) {
					count_declares(v as BaseNode);
				}
			}
		};
		for (const stmt of sources.statements) count_declares(stmt);
	}
	const redeclared = new Set(
		[...body_decl_count.entries()].filter(([, c]) => c > 1).map(([n]) => n),
	);
	// Accumulator-aware eligibility (ASM_PLAN_2 tranche D): a variable
	// WRITTEN in the loop body is a loop-carried accumulator/induction —
	// its slot round-trips execute every iteration even when the TEXT has
	// a single read (e.g. `var a = 0.0` read once as `a = a + …`). Those
	// qualify with reads >= 1; everything else keeps the reads >= 3 bar.
	const body_writes = new Set<string>();
	for (const stmt of sources.statements) {
		collect_assign_targets(stmt, body_writes);
	}
	for (const [name, info] of all_refs) {
		// Call-free extension mode (ASM_PLAN_2 tranche F): entry loads and
		// exit store-backs amortize across every iteration, so ANY var read
		// at least once in the body is a candidate (hottest first, all the
		// aliasing/redeclare exclusions below still apply). Outside that
		// mode the classic bars hold: reads >= 3, or the accumulator rule
		// (written in the body with reads >= 1 — ASM_PLAN_2 tranche D).
		const ext_mode = options?.call_free === true && options?.int_ext === true;
		const is_accumulator = body_writes.has(name) && info.reads >= 1;
		if (info.reads < (ext_mode ? 1 : 3) && !is_accumulator) continue;
		if (info.address_taken) continue;
		if (redeclared.has(name)) continue;
		// Aliasing-aware exclusions (critical for accumulator eligibility —
		// a promoted alias/ref breaks write-through semantics):
		if (status.function_ref_params?.has(name)) continue;
		if (status.function_ref_params?.has(`&${name}`)) continue;
		if (status.heap_strings?.has(name)) continue;
		if (status.class_alias_vars?.has(name)) continue;
		if (status.ref_class_slots?.has(name)) continue;
		if (status.heap_array_vars?.has(name)) continue;
		if (status.function_struct_param_slots?.has(name)) continue;
		if (status.register_allocations?.has(name)) continue;
		// Body-declared vars have no scoped declaration yet — their recorded
		// declare type is authoritative (and required: an unknown type can't
		// be register-classed).
		const dtype = body_decl_type.get(name);
		if (dtype !== undefined && !SCALAR_TYPES.includes(dtype)) continue;
		// Shadow gate: a body-declared name that shadows an OUTER declaration
		// must not be promoted — the register would diverge from the name-
		// keyed slot model after the loop (the documented shadowed-local
		// divergence class).
		if (dtype !== undefined && scoped_declarations.some((d) => d.name === name)) {
			continue;
		}
		const decl = scoped_declarations.find((d) => d.name === name);
		let type_name = "";
		if (decl) {
			type_name = decl.type?.name || "";
			if (!SCALAR_TYPES.includes(type_name)) continue;
		}
		// Declare-slot pre-allocation (ASM_PLAN_2 tranche D addendum): a
		// body-declared local has no slot until its declare builds — which
		// happens AFTER this pass ran. Allocate the slot NOW (same size and
		// alignment the declare build uses) and record it in
		// `preallocated_decl_slots`; the declare build detects the record and
		// reuses this exact offset, so the entry load below, the exit
		// store-back, and every slot access share one slot. (The naive
		// version that pre-allocated without the declare-side reuse let the
		// entry load read a stale slot the declare never wrote — run-
		// dependent output from uninitialized memory.) Only names with a
		// known scalar declare type reach this point, so the size is sound;
		// outer-scope vars always have their slot already.
		let offset = status.stack_offsets?.get(name);
		if (offset === undefined) {
			if (dtype === undefined || dtype === "") continue;
			const size = aarch64_size(dtype);
			if (!status.stack_offsets) status.stack_offsets = new Map();
			offset = allocate_stack_space(status, size, size);
			status.stack_offsets.set(name, offset);
			if (!status.preallocated_decl_slots) status.preallocated_decl_slots = new Map();
			status.preallocated_decl_slots.set(name, size);
		}
		eligible.push({ name, reads: info.reads, offset, type_name: type_name || dtype || "" });
	}

	eligible.sort((a, b) => b.reads - a.reads);

	if (!status.register_allocations) {
		status.register_allocations = new Map();
	}

	const used_regs = new Set(status.register_allocations.values());
	const used_x = new Set<string>();
	const used_d = new Set<string>();
	for (const r of used_regs) {
		if (r.startsWith("d")) used_d.add(r);
		else used_x.add(r);
	}
	// Avoid callee-saved registers already claimed by an enclosing loop's
	// promoted variables or Buffer data-pointer caches — reusing one would
	// clobber the outer loop's value across this loop's body. Split by
	// register class so a claimed d-register actually blocks the float
	// pool (adding every name to used_x left d8-d15 claims invisible to
	// the FLOAT_CALLEE_SAVED scan).
	if (status.callee_saved_regs_used) {
		for (const r of status.callee_saved_regs_used) {
			if (r.startsWith("d")) used_d.add(r);
			else used_x.add(r);
		}
	}
	// NIR-level function allocation (ASM_PLAN_2 tranche G): caller-saved
	// ext registers held by call-free-contained variable ranges. This set
	// survives the inline-expansion path's register_allocations clear, so
	// a loop inside an inline-expanded body cannot reclaim one while the
	// caller's variable is live across the expansion.
	if (status.nir_caller_saved_claimed) {
		for (const r of status.nir_caller_saved_claimed) used_x.add(r);
	}
	const float_pool =
		options?.call_free === true
			? [...FLOAT_CALLEE_SAVED, ...FLOAT_CALLER_SAVED_EXT]
			: FLOAT_CALLEE_SAVED;
	// Int pool: callee-saved first, then the call-free caller-saved
	// extension (gated off when a NEON plan rides — its preheader/lanes
	// clobber x12-x15).
	const x_pool =
		options?.call_free === true && options?.int_ext === true
			? [...CALLEE_SAVED_REGS, ...INT_CALLER_SAVED_EXT]
			: CALLEE_SAVED_REGS;
	let x_idx = 0;
	let d_idx = 0;
	for (const v of eligible) {
		const is_float = ALL_FLOAT_TYPES.includes(v.type_name);
		if (is_float) {
			while (d_idx < float_pool.length && used_d.has(float_pool[d_idx])) {
				d_idx++;
			}
			if (d_idx >= float_pool.length) continue;
			const reg = float_pool[d_idx];
			status.register_allocations.set(v.name, reg);
			used_d.add(reg);
			promoted.push({
				name: v.name,
				reg,
				offset: v.offset,
				type_name: v.type_name,
			});
			// The cached register must be loaded with the slot's width —
			// bool/char/int8 slots are 1-byte strb stores, so a full-width
			// `ldr` would pull dirty stack bytes into the cache.
			emit_promoted_load(status, reg, v.offset, v.type_name);
			d_idx++;
		} else {
			while (x_idx < x_pool.length && used_x.has(x_pool[x_idx])) {
				x_idx++;
			}
			if (x_idx >= x_pool.length) continue;
			const reg = x_pool[x_idx];
			status.register_allocations.set(v.name, reg);
			used_x.add(reg);
			promoted.push({
				name: v.name,
				reg,
				offset: v.offset,
				type_name: v.type_name,
			});
			emit_promoted_load(status, reg, v.offset, v.type_name);
			x_idx++;
		}
	}

	if (promoted.length > 0) {
		if (!status.callee_saved_regs_used) {
			status.callee_saved_regs_used = new Set();
		}
		for (const p of promoted) {
			// Caller-saved extension regs are NOT callee-saved — the prologue
			// must not save them (call-free loop, storeback covers the exit).
			if (!p.reg.startsWith("d2") && !p.reg.startsWith("d3") && !/^x1[0-5]$/.test(p.reg)) {
				status.callee_saved_regs_used.add(p.reg);
			}
		}
	}

	return promoted;
}
