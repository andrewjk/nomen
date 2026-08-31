import type BuildStatus from "../../build_c/BuildStatus.ts";
import { ALL_FLOAT_TYPES, SCALAR_TYPES } from "../../built_in_types.ts";
import {
	analyze_dominance,
	analyze_loops,
	analyze_liveness,
	reachable_blocks,
} from "../../nir/analysis.ts";
import { build_cfg, type FunctionCfg } from "../../nir/cfg.ts";
import { lower_function } from "../../nir/from_ast.ts";
import type { NirFunction } from "../../nir/nir.ts";
import { analyze_traffic } from "../../nir/traffic.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type Type from "../../nodes/Type.ts";
import { tree_is_call_free } from "../build_operation_node.ts";
import { emit_promoted_load } from "./stack_var.ts";

/**
 * NIR-level int register allocation, stage 1 (ASM_PLAN_2 tranche G).
 *
 * Where tranche F left the int side, the whole-function pass promoted the
 * four hottest scalars into fixed callee-saved slots (x23-x26) by RAW READ
 * COUNT, with no notion of WHEN a value is live. clang's limb loops keep
 * ~10 scalars in registers simultaneously; our cap could not express that.
 *
 * This pass replaces the ranking with real dataflow over the canonical IR:
 *
 * - the lowered function builds its CFG (src/nir/cfg.ts) and runs may-
 *   liveness; a per-statement BACKWARD walk inside every block yields
 *   statement-granularity live sets;
 * - each def position interferes with everything live after it — two
 *   variables whose live ranges never overlap SHARE one register, so more
 *   variables fit than the pool has registers;
 * - a statement whose evaluation contains a call (or is a liveness
 *   barrier: raw asm, unmapped constructs) is a CROSSING POINT: a variable
 *   live across it must sit in a callee-saved register; a variable whose
 *   entire range avoids every call may live in the caller-saved extension
 *   pool x12-x15 (zero prologue cost — the same discipline tranche F
 *   proved for call-free LOOP bodies, generalized to any call-free range);
 * - a variable live INTO any loop header never gets a caller-saved
 *   register: the NEON vector loop's preheader/lanes clobber x9-x14, and
 *   the planner cannot know at plan time which loops will vectorize. Live
 *   ranges contained INSIDE a loop body (def'd and dead between header
 *   crossings — the Knuth-D limb temporaries this tranche exists for) are
 *   exactly the ones not live-in at the header, so the profitable case
 *   survives the gate.
 *
 * Crossing refinement: a statement whose only "call" is an inline method
 * with a call-free body (tranche F's `tree_is_call_free` verdict — BigInt
 * `mul_wide_hi` yes, `div128` → ___udivti3 no) is NOT a crossing point;
 * its expansion stays in x0-x9 and never issues `bl`.
 *
 * Eligibility otherwise mirrors plan_function_promotions: clean scalar
 * types only, declared exactly once, never a ref argument, never
 * address-taken, never colliding with a parameter name. PARAMS are PINNED
 * (they never share): the prologue initializes every promoted param's
 * register unconditionally, so two names on one register would race.
 * Params additionally interfere with everything live at function entry.
 *
 * Low-read extension: an int local with ANY root-body reads whose range is
 * call-free-contained and never spans a loop header becomes a caller-saved-
 * ONLY candidate — a contained ext-pool register has no prologue cost, so
 * even 1-2 textual reads pay (Knuth-D limb temporaries: `vv`, `lo_prod`,
 * `hi_prod` — def'd, multiplied, and dead within one iteration).
 *
 * Floats keep the legacy allocation exactly (d8-d15, hottest four) so the
 * float side is byte-stable with plan_function_promotions; this pass is
 * about the INT side.
 *
 * Kill-switch: `set_nir_regalloc_enabled` (default ON; false falls back
 * to the legacy pass — kept for A/B comparisons and debugging).
 */

let nir_regalloc_on = true;

/** Kill-switch for A/B byte-identity tests (default: ON — the NIR-level
 *  allocator replaced the legacy read-count pass in tranche G; set false
 *  to fall back to plan_function_promotions). */
export function nir_regalloc_enabled(): boolean {
	return nir_regalloc_on;
}

export function set_nir_regalloc_enabled(enabled: boolean): void {
	nir_regalloc_on = enabled;
}

const CALLEE_SAVED_X = ["x23", "x24", "x25", "x26", "x27", "x28"];
/** Caller-saved extension pool: call-free-contained ranges only. x10/x11
 *  stay excluded (write barriers / tree temps), x9 is emitter scratch. */
const CALLER_SAVED_EXT_X = ["x12", "x13", "x14", "x15"];
const D_POOL = ["d8", "d9", "d10", "d11", "d12", "d13", "d14", "d15"];
/** Distinct callee-saved int registers this pass may claim — x27/x28 stay
 *  available to loop promotion and Buffer data-pointer caches (legacy cap). */
const MAX_X_CALLEE = 4;
const MAX_D_REGS = 4;
/** Reads (textual, function-wide) below which a CALLEE-SAVED promotion
 *  never pays its prologue save (legacy bar). Caller-saved assignments
 *  have no prologue cost and need only one root-body read. */
const MIN_READS = 4;

interface Candidate {
	name: string;
	reads: number;
	weight: number;
	type_name: string;
	/** A low-read call-free-contained local: caller-saved ext pool ONLY
	 *  (it never cleared the callee-saved prologue-cost bar). */
	caller_only: boolean;
}

/** Per-name facts derived from statement-granularity liveness over the
 *  ROOT function's CFG (nested functions analyze as their own units). */
interface RangeFacts {
	/** Read occurrences in the root body (nested bodies not counted). */
	reads: number;
	/** The range crosses a call or liveness barrier — callee-saved only. */
	crosses_call: boolean;
	/** Live into some loop header — never caller-saved (NEON preheaders). */
	loop_blocked: boolean;
}

export interface NirRegisterPlan {
	allocs: Map<string, string>;
	/** Callee-saved registers ONLY — the prologue's save/restore set.
	 *  Caller-saved ext regs must not ride it. */
	callee_saved: Set<string>;
	/** Function-wide interference adjacency (name → interfering names) —
	 *  exported so LOOP promotion can share function-claimed registers
	 *  when its candidate provably never overlaps the occupants. */
	adj: Map<string, Set<string>>;
	/** Param claims — pinned, never shared with loop promotions. */
	pinned: Set<string>;
}

export interface NirRegisterPlanOptions {
	/** Enables the inline-call-free crossing refinement (tranche F's
	 *  `tree_is_call_free`); omitted = every has_call statement crosses. */
	status?: BuildStatus;
	/** Parameter names never to promote (e.g. a method's `self`, which the
	 *  method ABI parks in x19/x20 with its own conventions). */
	exclude_params?: Set<string>;
}

interface RangeAnalysis {
	facts: Map<string, RangeFacts>;
	/** Symmetric interference adjacency (def-point rule: a def interferes
	 *  with everything live after it). */
	adj: Map<string, Set<string>>;
}

function is_clean_scalar_type(t: {
	name?: string;
	is_array?: boolean;
	is_view?: boolean;
	is_ref?: boolean;
	is_nullable?: boolean;
}): boolean {
	return (
		!!t.name &&
		SCALAR_TYPES.includes(t.name) &&
		!t.is_array &&
		!t.is_view &&
		!t.is_ref &&
		!t.is_nullable
	);
}

/**
 * Statement-granularity liveness walk. Per reachable block: start from the
 * block's live-out, fold the terminator, then walk statements BACKWARD —
 * at each statement the current set IS live-after, defs cut it, reads add
 * to it, barriers reset it to the universe. Defs interfere with the
 * live-after set; call/barrier statements mark everything live across
 * them as crossing. Params get virtual defs at function entry.
 *
 * A statement whose only "call" is an inline method with a call-free body
 * (tranche F's `tree_is_call_free` verdict — e.g. BigInt `mul_wide_hi`)
 * is NOT a crossing point: its expansion stays in x0-x9 and never issues
 * `bl`. Requires `status` for the struct lookup; without it every
 * has_call statement crosses (conservative).
 */
export function analyze_ranges(cfg: FunctionCfg, status?: BuildStatus): RangeAnalysis {
	const crossing = (node: BaseNode | undefined): boolean => {
		if (!status || !node) return true;
		return !tree_is_call_free(node, status, new Set());
	};
	const facts = new Map<string, RangeFacts>();
	const adj = new Map<string, Set<string>>();
	const facts_of = (name: string): RangeFacts => {
		let f = facts.get(name);
		if (!f) {
			f = { reads: 0, crosses_call: false, loop_blocked: false };
			facts.set(name, f);
		}
		return f;
	};
	const add_edge = (a: string, b: string): void => {
		if (a === b) return;
		let sa = adj.get(a);
		if (!sa) {
			sa = new Set();
			adj.set(a, sa);
		}
		sa.add(b);
		let sb = adj.get(b);
		if (!sb) {
			sb = new Set();
			adj.set(b, sb);
		}
		sb.add(a);
	};
	const reach = reachable_blocks(cfg);
	const liveness = analyze_liveness(cfg);
	for (const b of cfg.blocks) {
		if (!reach[b.id]) continue;
		let live = new Set(liveness.live_out[b.id]);
		const mark_crossing = (names: Iterable<string>): void => {
			for (const v of names) facts_of(v).crosses_call = true;
		};
		if (b.term.t === "branch" || b.term.t === "return") {
			const t = b.term;
			const has_real_call =
				t.barrier ||
				(t.has_call && crossing(t.t === "branch" ? t.cond?.node : (t.value?.node as BaseNode)));
			if (has_real_call) {
				mark_crossing(live);
				mark_crossing(t.reads);
			}
			for (const r of t.reads) {
				facts_of(r).reads++;
				live.add(r);
			}
		}
		for (let i = b.stmts.length - 1; i >= 0; i--) {
			const s = b.stmts[i];
			if (s.barrier || (s.has_call && crossing(s.node))) {
				mark_crossing(live);
				mark_crossing(s.reads);
			}
			for (const r of s.reads) {
				facts_of(r).reads++;
				live.add(r);
			}
			for (const d of s.defs) {
				for (const v of live) add_edge(d, v);
				live.delete(d);
			}
			if (s.barrier) live = new Set(cfg.names);
		}
		if (b.id === cfg.entry) {
			// Virtual param defs at function entry: a param's register is
			// written in the prologue, so it interferes with everything
			// live at entry (including other params).
			for (const p of cfg.params) {
				for (const v of live) add_edge(p.name, v);
				live.delete(p.name);
			}
		}
	}
	// Loop-header gate for the caller-saved pool.
	const dominance = analyze_dominance(cfg);
	const loops = analyze_loops(cfg, dominance);
	for (const loop of loops.loops) {
		for (const v of liveness.live_in[loop.header]) facts_of(v).loop_blocked = true;
	}
	return { facts, adj };
}

/**
 * Plan register assignments for a function body. Eligibility mirrors
 * plan_function_promotions (traffic-driven); assignment differs:
 * statement-granularity interference lets non-overlapping int ranges
 * SHARE registers, and call-free-contained int ranges may take the
 * caller-saved x12-x15 extension pool instead of spending a callee-saved
 * register (and its prologue save).
 */
export function plan_nir_registers(
	func: {
		params: { name: string; type: Type; is_variadic?: boolean }[];
		statements: BaseNode[];
	},
	nir: NirFunction,
	options?: NirRegisterPlanOptions,
): NirRegisterPlan {
	const allocs = new Map<string, string>();
	const callee_saved = new Set<string>();
	const pinned = new Set<string>();
	const traffic = analyze_traffic(nir);

	const address_taken = new Set<string>();
	for (const [name, info] of traffic.variables) {
		if (info.address_taken) address_taken.add(name);
	}
	const param_names = new Set(func.params.map((p) => p.name));
	const excluded = (name: string): boolean => !!options?.exclude_params?.has(name);

	const cfg = build_cfg(nir);
	const { facts, adj } = analyze_ranges(cfg, options?.status);

	const candidates: Candidate[] = [];
	for (const decl of traffic.decls) {
		if (!is_clean_scalar_type({ name: decl.type_name, ...decl.modifiers })) continue;
		const name = decl.name;
		if ((traffic.decl_counts.get(name) ?? 0) !== 1) continue;
		if (param_names.has(name)) continue;
		if (traffic.ref_arg_names.has(name)) continue;
		if (address_taken.has(name)) continue;
		const r = traffic.variables.get(name);
		if (!r || r.reads < 1) continue;
		const is_float = ALL_FLOAT_TYPES.includes(decl.type_name);
		const f = facts.get(name);
		if (r.reads < MIN_READS) {
			// Low-read extension: int locals only, caller-saved-only, and
			// only with a provably call-free, loop-free-contained range.
			if (is_float) continue;
			if (!f || f.reads < 1 || f.crosses_call || f.loop_blocked) continue;
			candidates.push({
				name,
				reads: r.reads,
				weight: r.weighted_reads,
				type_name: decl.type_name,
				caller_only: true,
			});
			continue;
		}
		if (!is_float) {
			// Int candidates must have at least one live-range position in
			// the root body — reads that exist only inside nested functions
			// (separate compilation units) are not promotable here.
			if (!f || f.reads < 1) continue;
		}
		candidates.push({
			name,
			reads: r.reads,
			weight: r.weighted_reads,
			type_name: decl.type_name,
			caller_only: false,
		});
	}
	for (const param of func.params) {
		if (param.is_variadic) continue;
		if (excluded(param.name)) continue;
		if (!is_clean_scalar_type(param.type)) continue;
		if ((traffic.decl_counts.get(param.name) ?? 0) !== 0) continue;
		if (traffic.ref_arg_names.has(param.name)) continue;
		if (address_taken.has(param.name)) continue;
		const r = traffic.variables.get(param.name);
		if (!r || r.reads < MIN_READS) continue;
		if (!ALL_FLOAT_TYPES.includes(param.type.name ?? "")) {
			const f = facts.get(param.name);
			if (!f || f.reads < 1) continue;
		}
		candidates.push({
			name: param.name,
			reads: r.reads,
			weight: r.weighted_reads,
			type_name: param.type.name,
			caller_only: false,
		});
	}
	if (candidates.length === 0) return { allocs, callee_saved, adj, pinned };

	// Hottest first — same ranking the legacy pass and the benchmarks
	// were tuned around (raw reads, then loop-weighted, V8 stable sort).
	candidates.sort((a, b) => b.reads - a.reads || b.weight - a.weight);

	// Register → EVERY name sharing it. Sharing means several names live
	// in one physical register, so a single name→reg map would forget the
	// earlier occupants and let an interfering latecomer slip in (the
	// fannkuch-redux corruption the benchmark receipt caught: p0 and
	// flips overlapped through a chain of non-interfering sharers).
	const held = new Map<string, Set<string>>();
	const occupants_of = (reg: string): Set<string> => {
		let s = held.get(reg);
		if (!s) {
			s = new Set();
			held.set(reg, s);
		}
		return s;
	};
	let d_used = 0;
	let x_callee_used = 0;
	for (const c of candidates) {
		if (ALL_FLOAT_TYPES.includes(c.type_name)) {
			// Float side: legacy allocation, byte-stable with the old pass.
			if (d_used >= MAX_D_REGS) continue;
			const reg = D_POOL[d_used++];
			allocs.set(c.name, reg);
			occupants_of(reg).add(c.name);
			callee_saved.add(reg);
			continue;
		}
		const f = facts.get(c.name);
		if (!f) continue;
		const pinned_name = param_names.has(c.name);
		const caller_eligible = !pinned_name && !f.crosses_call && !f.loop_blocked;
		if (c.caller_only && !caller_eligible) continue;
		// Caller-saved first (no prologue cost, keeps callee regs for loops
		// and Buffer caches), then callee-saved. Every non-caller_only int
		// candidate cleared the traffic MIN_READS bar and has >= 1 root
		// read, so the callee pool is always an option; the
		// distinct-register cap below bounds how many fresh callee slots
		// the pass may claim.
		const pool_order = [
			...(caller_eligible ? CALLER_SAVED_EXT_X : []),
			...(c.caller_only ? [] : CALLEE_SAVED_X),
		];
		for (const reg of pool_order) {
			const occupants = occupants_of(reg);
			const is_callee = CALLEE_SAVED_X.includes(reg);
			if (occupants.size === 0) {
				if (is_callee && x_callee_used >= MAX_X_CALLEE) continue;
				allocs.set(c.name, reg);
				occupants.add(c.name);
				if (pinned_name) pinned.add(c.name);
				if (is_callee) {
					x_callee_used++;
					callee_saved.add(reg);
				}
				break;
			}
			// Sharing: the newcomer must be non-pinned and must not
			// interfere with ANY current occupant (nor may an occupant be
			// a pinned param — its prologue init is unconditional).
			if (pinned_name) continue;
			let blocked = false;
			for (const occupant of occupants) {
				if (param_names.has(occupant) || adj.get(c.name)?.has(occupant)) {
					blocked = true;
					break;
				}
			}
			if (blocked) continue;
			allocs.set(c.name, reg);
			occupants.add(c.name);
			break;
		}
	}
	return { allocs, callee_saved, adj, pinned };
}

/**
 * Seed a STANDALONE method/init/destroy body's build with its own
 * function-level allocation plan. Struct methods never went through
 * plan_function_promotions — build_struct_functions clears the promotion
 * maps and builds the body via build_body_with_cursor, so every method
 * local lived on the stack. This helper lowers + plans + seeds the SAME
 * status maps the emitters already consult, then loads each promoted
 * scalar param from its freshly-spilled prologue slot (the slot was just
 * written from the incoming register; a width-aware load zero-extends
 * exactly like a body read — the same argument the function-level
 * prologue makes).
 *
 * Call it AFTER the prologue's param spills, immediately before
 * build_body_with_cursor. The caller's existing post-body capture
 * (`callee_saved_regs_used` → save/restore patch) picks up the plan's
 * callee-saved registers automatically; caller-saved ext regs never enter
 * that set. Returns the plan (or undefined when nothing was promoted).
 */
export function seed_function_allocations(
	func: Parameters<typeof lower_function>[0],
	status: BuildStatus,
	options?: { exclude_params?: Set<string> },
): NirRegisterPlan | undefined {
	const nir = lower_function(func);
	if (nir.unknown_kinds.size > 0) {
		// The build_body_with_cursor call right after us lowers again and
		// throws the same tripwire; stay out of its way here.
		return undefined;
	}
	const plan = plan_nir_registers(func, nir, {
		status,
		exclude_params: options?.exclude_params,
	});
	if (plan.allocs.size === 0) return undefined;
	status.register_allocations = plan.allocs;
	status.callee_saved_regs_used = plan.callee_saved.size > 0 ? plan.callee_saved : undefined;
	// Interference facts for loop-promotion sharing (see BuildStatus).
	status.nir_alloc_shared = { adj: plan.adj, pinned: plan.pinned };
	// Caller-saved ext claims survive inline expansions (which clear
	// register_allocations); the method caller restores the old value.
	status.nir_caller_saved_claimed = new Set(
		[...plan.allocs.values()].filter((r) => /^x1[2-5]$/.test(r)),
	);
	if (status.nir_caller_saved_claimed.size === 0) status.nir_caller_saved_claimed = undefined;
	for (const param of func.params) {
		const reg = plan.allocs.get(param.name);
		if (!reg || !reg.startsWith("x")) continue;
		const offset = status.stack_offsets?.get(param.name);
		if (offset !== undefined) {
			emit_promoted_load(status, reg, offset, param.type.name ?? "");
		}
	}
	return plan;
}
