import type BuildStatus from "../../build_c/BuildStatus.ts";
import { ALL_FLOAT_TYPES, SCALAR_TYPES } from "../../built_in_types.ts";
import {
	analyze_dominance,
	analyze_loops,
	analyze_liveness,
	reachable_blocks,
	type DominanceResult,
} from "../../nir/analysis.ts";
import { build_cfg, type FunctionCfg } from "../../nir/cfg.ts";
import { lower_function } from "../../nir/from_ast.ts";
import type { NirFunction, NirStmt } from "../../nir/nir.ts";
import { analyze_traffic } from "../../nir/traffic.ts";
import { version_function } from "../../nir/version.ts";
import type AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type Type from "../../nodes/Type.ts";
import { tree_is_call_free } from "../build_operation_node.ts";
import { publish_slp_pairs, slp_pair_enabled, slp_pair_hints } from "../slp_pair.ts";
import { value_number_loops } from "../value_number.ts";
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

let nir_site_promotion_on = true;

/**
 * Kill-switch for decl-site promotion (stage 3; default ON). OFF restores
 * the stage-2 exclusion of names declared more than once — every register
 * binding is function-wide and installed before the prologue, so emission
 * is byte-identical with and without the NIR cursor (the byte-identity
 * harness holds this off in both arms, the same way it holds off the NEON
 * vectorizer: the site hook is cursor-dependent by design).
 */
export function nir_site_promotion_enabled(): boolean {
	return nir_site_promotion_on;
}

export function set_nir_site_promotion_enabled(enabled: boolean): void {
	nir_site_promotion_on = enabled;
}

const CALLEE_SAVED_X = ["x23", "x24", "x25", "x26", "x27", "x28"];
/** Caller-saved extension pool: call-free-contained ranges only. x10/x11
 *  stay excluded (write barriers / tree temps), x9 is emitter scratch.
 *  Exported for the region bracket (extension-pool pins). */
export const CALLER_SAVED_EXT_X = ["x12", "x13", "x14", "x15"];
const D_POOL = ["d8", "d9", "d10", "d11", "d12", "d13", "d14", "d15"];
const MAX_D_REGS = 4;
/** Distinct callee-saved int registers this pass may claim. The legacy cap
 *  of 4 kept x27/x28 "available" to loop promotion and Buffer caches — but
 *  every runtime claimant (array_ptr_cache, Buffer data cache, loop
 *  promotion) already excludes `callee_saved_regs_used`, so claimed
 *  registers are respected. Tranche H lifts the cap to the full pool: 4+
 *  -read candidates were missing out purely on pool depth. (Re-barring
 *  LOW-read loop-spanning names into the pool was tried and reverted the
 *  same session: the admitted written loop state collides with the inline
 *  expansion path's claim seeding — mandelbrot hung at n=16. See
 *  ASM_PLAN_3.md tranche H.) */
const MAX_X_CALLEE = 6;
/** Reads (textual, function-wide) below which a CALLEE-SAVED promotion
 *  never pays its prologue save (legacy bar). Caller-saved assignments
 *  have no prologue cost and need only one root-body read. */
const MIN_READS = 4;
/** Tranche H (re-land, post expansion fixes): a NEVER-WRITTEN
 *  loop-spanning name (BigInt's bp/sp/divisor — one init at the declare,
 *  read-only after) repeats its reads EVERY iteration, so the prologue
 *  save amortizes immediately and loop-weighted traffic — not the raw
 *  count — decides the callee-saved bar. Written loop state (inductions,
 *  accumulators) is deliberately excluded: they already have
 *  loop-promotion bracketing coherence, and double-claiming them is the
 *  mandelbrot hang receipt. */
const LOOP_INVARIANT_MIN_WEIGHT = 8;
let callee_pool_extended = true;

/** Kill-switch for region-scoped pool claims + loop receiver pins
 *  (ASM_PLAN_5, default ON; OFF restores the function-wide-only plan —
 *  byte-identical). Lives here so the plan and the emitter bracket share
 *  one toggle without import cycles. */
let region_pool_on = true;

export function region_pool_enabled(): boolean {
	return region_pool_on;
}

export function set_region_pool_enabled(enabled: boolean): void {
	region_pool_on = enabled;
}

/** Buffer fast-path accessors whose receiver derivation a region pin
 *  materializes (the same window-safe family the staging pass trusts). */
const BUFFER_PIN_ACCESSORS = new Set([
	"load_int",
	"load",
	"load_float",
	"store_int",
	"store",
	"store_float",
	"store_or_int",
]);

/**
 * Raw stable accessors (BigInt.get/set/get_at/set_at/data_ptr): indexed
 * limb access through the CURRENT data pointer. Their raw bodies only read
 * digits.data and issue indexed loads/stores — they never write the data
 * field and (being call-free) cannot reach ensure/grow, so they never
 * rewire the receiver path a region pin materializes. A may-def of the
 * receiver root by one of these calls is the accessor's own marshalling
 * (the D6-unnormalize receipt: `remainder.set(ri, …)` refused the
 * `remainder.digits` pin its own loop's load_int collected), NOT a foreign
 * write. Consulted ONLY for the own-roots marshalling allowance — these
 * calls derive nothing pinnable themselves.
 */
const RAW_STABLE_ACCESSORS = new Set(["get", "set", "get_at", "set_at", "data_ptr"]);

/** Accessor names whose receiver-root may-defs are the call's own
 *  marshalling rather than a cell rewrite. */
function marshalling_accessor(name: string): boolean {
	return BUFFER_PIN_ACCESSORS.has(name) || RAW_STABLE_ACCESSORS.has(name);
}

/** The receiver key a buffer_cache_key pin would take: a plain name or
 *  exactly one field hop off a name (deeper chains and exotic receivers
 *  return null — no pin). */
/** AST value nodes in identifier positions carry the bare name (no
 *  is_identifier_like flag — that is a NIR-leaf concept); refuse literals
 *  and keywords so keys always name a variable. */
const NON_NAME_VALUES = new Set(["null", "true", "false", "this", "self", "super"]);

function plain_or_field_key(receiver: BaseNode): string | null {
	const name_ok = (v: unknown): v is string =>
		typeof v === "string" && v.length > 0 && !/^[0-9-]/.test(v) && !NON_NAME_VALUES.has(v);
	if (receiver.node_type === "value") {
		const v = (receiver as unknown as { value?: unknown }).value;
		return name_ok(v) ? v : null;
	}
	if (receiver.node_type === "access") {
		const a = receiver as AccessNode;
		if (a.target && a.target.node_type === "value" && a.access?.node_type === "access_field") {
			const v = (a.target as unknown as { value?: unknown }).value;
			const field = (a.access as unknown as { name?: unknown }).name;
			if (name_ok(v) && name_ok(field)) return `${v}.${field}`;
		}
	}
	return null;
}

/**
 * Whether an accessor receiver is BigInt-typed (the raw stable family's
 * marshalling allowance applies only there — a `set` on any other type may
 * rewire). Value nodes carry the checker's attribution; field-hop receivers
 * resolve through their root. Missing attribution is conservative (false).
 */
function receiver_is_bigint(receiver: BaseNode): boolean {
	const t = (receiver as unknown as { type?: { name?: unknown } }).type;
	if (t && t.name === "BigInt") return true;
	if (receiver.node_type === "access") {
		const target = (receiver as AccessNode).target;
		if (target && target !== receiver) return receiver_is_bigint(target);
	}
	return false;
}

/** Kill-switch for the tranche-H callee-pool extension (default ON; OFF
 *  restores MAX_X_CALLEE = 4 and the raw-read-only bar — byte-identical). */
export function nir_callee_pool_extended(): boolean {
	return callee_pool_extended;
}

export function set_nir_callee_pool_extended(enabled: boolean): void {
	callee_pool_extended = enabled;
}

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
	 *  when its candidate provably never overlaps the occupants. Keys are
	 *  source names for uniquely-declared variables, decl-site keys
	 *  (`name@N`) for ambiguous ones (stage 3). */
	adj: Map<string, Set<string>>;
	/** Param claims — pinned, never shared with loop promotions. */
	pinned: Set<string>;
	/** Source name → every key it owns in the renamed view (its plain name
	 *  when uniquely declared; all its `name@N` site keys otherwise). Loop
	 *  promotion's candidates are plain AST names, so sharing checks must
	 *  consult edges for EVERY key a name could be — a single-key lookup
	 *  would miss site-keyed occupants and "share" over a live range (the
	 *  stage-3 rebirth of the stage-2 vacuous-share bug). */
	source_keys: Map<string, string[]>;
	/** Decl-site allocations (stage 3): key → source name + register. The
	 *  emitter binds these at the declare site (frame-scoped), not from
	 *  function entry — two sibling scopes declaring the same name each
	 *  bind their own register. */
	sites: Map<string, { name: string; reg: string }>;
	/** Field-pair SLP lanes (ASM_PLAN_4): ordered (a, b) pairs the plan
	 *  allocated — a in its d-register (lane 0), b lane-resident in
	 *  vN.d[1] (excluded from the candidate set). The caller publishes
	 *  these on status.slp_pair_hints / slp_pair_vregs. */
	pairs: { a: string; b: string; vreg: string }[];
	/** Region-scoped pool claims (ASM_PLAN_5): per loop, pool registers
	 *  whose occupants are dead inside the loop (with the occupants the
	 *  emitter must spill/reload around the body) and the loop's
	 *  loop-invariant Buffer receiver paths to pin. `dead` is EVERY
	 *  occupant key (site keys included) — the emitter's bound-register
	 *  check allows a pin whose register is bound only to proven-dead
	 *  names, so function-wide occupants (visible in the live
	 *  register_allocations map but dead here) borrow while emit-time
	 *  promotion claims (unknown to the plan) still refuse. */
	region_free: {
		node: BaseNode;
		pins: {
			reg: string;
			displaced: { name: string; key: string; type_name: string }[];
			dead: string[];
		}[];
		receivers: { key: string; node: BaseNode; call: BaseNode }[];
	}[];
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
	/** name → CFG blocks where the name is live or defined (region checks) */
	block_members: Map<string, Set<number>>;
	/** Natural loops (header block id + the loop's block set). */
	loop_list: { header: number; blocks: Set<number>; exits: number[] }[];
	/** Per-block liveness (region membership input). */
	liveness: { live_in: Set<string>[]; live_out: Set<string>[] };
	/** Symmetric interference adjacency (def-point rule: a def interferes
	 *  with everything live after it). */
	adj: Map<string, Set<string>>;
	/** Dominator sets (region checks: nesting-complete loop bodies). */
	dominance: DominanceResult;
}

/** Every assign-target name in the lowered body (any list depth) — the
 *  tranche-H write-free gate for loop-invariant promotion. While/for
 *  UPDATE statements are walked: `y += 1` in the header writes y, and
 *  missing it admitted the inductions (the first mandelbrot hang). */
function collect_nir_assign_targets(stmts: readonly NirStmt[]): Set<string> {
	const out = new Set<string>();
	const walk = (list: readonly NirStmt[]): void => {
		for (const s of list) {
			switch (s.kind) {
				case "assign": {
					let e = s.target;
					while (e.kind === "wrap") e = e.inner ?? e;
					if (e.kind === "leaf" && e.name) out.add(e.name);
					break;
				}
				case "while":
					if (s.update) walk([s.update]);
					walk(s.body);
					break;
				case "for":
					out.add(s.item_name);
					if (s.update) walk([s.update]);
					walk(s.body);
					break;
				case "if":
					walk(s.then_branch);
					walk(s.else_branch);
					break;
				case "switch_match":
					for (const a of s.arms) walk(a.branch);
					if (s.otherwise) walk(s.otherwise);
					break;
				case "async_block":
				case "nested_func":
					walk(s.body);
					break;
				default:
					break;
			}
		}
	};
	walk(stmts);
	return out;
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
 * Nesting-complete loop body for region checks (ASM_PLAN_5 soundness hole:
 * the lru receipt). analyze_loops' latch pred-walk can MISS nested blocks —
 * the outer find-loop's set excluded its inner sh-loop, so an occupant live
 * in the nest (sh) tested dead in the outer and the bracket destroyed the
 * induction. The dominance + reachability characterization (header dominates
 * b, b reaches header) includes nested regions by construction; unioned with
 * the analyzed set it is the conservative body every region check must use
 * (union-only ever refuses more pins, never fewer).
 *
 * Exit-less nested loops (`while true` with no break, return-only nests)
 * never reach the outer header, so a second closure adds the analyzed
 * blocks of every other header dominated by this one that either reaches it
 * or has no exits. Headers past the loop (post-loop code) reach neither and
 * are excluded. `break`/`continue` target the innermost loop, so no nest
 * escapes outward except through return — return-only bodies with no latch
 * form no loop entry and remain a documented residual (FOLLOWUP).
 */
function region_loop_blocks(
	cfg: FunctionCfg,
	dominance: DominanceResult,
	header: number,
	analyzed: Set<number>,
	all_loops: { header: number; blocks: Set<number>; exits: number[] }[],
): Set<number> {
	const body = new Set<number>(analyzed);
	// Blocks that can reach the header (backward pred walk, reachable only).
	const reach_header = new Set<number>([header]);
	const stack: number[] = [header];
	while (stack.length > 0) {
		const b = stack.pop()!;
		for (const p of cfg.blocks[b].preds) {
			if (dominance.reachable[p] && !reach_header.has(p)) {
				reach_header.add(p);
				stack.push(p);
			}
		}
	}
	for (const b of reach_header) {
		if (dominance.dom[b]?.has(header)) body.add(b);
	}
	for (const other of all_loops) {
		if (other.header === header) continue;
		if (!dominance.dom[other.header]?.has(header)) continue;
		if (other.exits.length === 0 || reach_header.has(other.header)) {
			for (const b of other.blocks) body.add(b);
		}
	}
	return body;
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
	/** name → CFG blocks where the name is live at the boundary or defined
	 *  (conservative per-block membership for region-scoped allocation). */
	const block_members = new Map<string, Set<number>>();
	const member_of = (name: string, id: number): void => {
		let s = block_members.get(name);
		if (!s) {
			s = new Set();
			block_members.set(name, s);
		}
		s.add(id);
	};
	for (const b of cfg.blocks) {
		if (!reach[b.id]) continue;
		for (const v of liveness.live_in[b.id]) member_of(v, b.id);
		for (const v of liveness.live_out[b.id]) member_of(v, b.id);
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
				member_of(d, b.id);
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
	return {
		facts,
		adj,
		block_members,
		loop_list: loops.loops.map((l) => ({
			header: l.header,
			blocks: new Set(l.blocks),
			exits: [...l.exits],
		})),
		liveness,
		dominance,
	};
}

/**
 * Plan register assignments for a function body. Eligibility mirrors
 * plan_function_promotions (traffic-driven); assignment differs:
 * statement-granularity interference lets non-overlapping int ranges
 * SHARE registers, and call-free-contained int ranges may take the
 * caller-saved x12-x15 extension pool instead of spending a callee-saved
 * register (and its prologue save).
 */
/**
 * Float candidates belonging to a planned SLP pair walk first (their
 * lane-0 members must reach the d-pool before singles eat the budget);
 * every other candidate keeps its sorted order. Pair lane-1 members are
 * dropped (they take no register).
 */
function slp_pairs_ordered(
	candidates: Candidate[],
	partner_of: Map<string, string> | undefined,
): Candidate[] {
	if (!partner_of || partner_of.size === 0) return candidates;
	const pairs: Candidate[] = [];
	const rest: Candidate[] = [];
	for (const c of candidates) {
		if (partner_of.has(c.name)) pairs.push(c);
		else rest.push(c);
	}
	return [...pairs, ...rest];
}

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
	const site_allocs = new Map<string, { name: string; reg: string }>();

	// Stage 3 (decl-site disambiguation): every source name declared more
	// than once anywhere in the lowered body — sibling-loop consts, shadow
	// redeclares, same-named locals across arms — is renamed per declare
	// site (`name@N`), so each site gets its own live range, interference
	// edges and register instead of being excluded wholesale. Uniquely
	// declared names bind identity: the versioned view is byte-equal to the
	// original lowering and the plan keys stay source names. Kill-switch
	// off restores the stage-2 wholesale exclusion.
	const source_decl_counts = analyze_traffic(nir).decl_counts;
	const multi = nir_site_promotion_enabled()
		? new Set([...source_decl_counts.entries()].filter(([, c]) => c > 1).map(([n]) => n))
		: new Set<string>();
	const { renamed, sites } = version_function(nir, multi);
	const traffic = analyze_traffic(renamed);

	const address_taken = new Set<string>();
	for (const [name, info] of traffic.variables) {
		if (info.address_taken) address_taken.add(name);
	}
	const param_names = new Set(func.params.map((p) => p.name));
	const excluded = (name: string): boolean => !!options?.exclude_params?.has(name);

	const cfg = build_cfg(renamed);
	const analysis = analyze_ranges(cfg, options?.status);
	const { facts, adj } = analysis;

	// Source name → every key it owns in the renamed view (see
	// NirRegisterPlan.source_keys). Every declare contributes its key; a
	// uniquely-declared name's key IS its plain name.
	const source_keys = new Map<string, string[]>();
	const add_key = (source: string, key: string): void => {
		const list = source_keys.get(source);
		if (list) list.push(key);
		else source_keys.set(source, [key]);
	};
	for (const decl of traffic.decls) {
		const site = sites.get(decl.name);
		add_key(site?.source ?? decl.name, decl.name);
	}

	// Writes are collected over the RENAMED body so every target carries its
	// decl-site key: the raw lowering's targets are plain names, and a
	// shadowed site checked against them looks never-written (the
	// shadowed-local regression the bar's first landing caught — the outer
	// site was admitted and the shadow's writes landed in its register).
	const body_writes = collect_nir_assign_targets(renamed.body);

	const candidates: Candidate[] = [];
	for (const decl of traffic.decls) {
		if (!is_clean_scalar_type({ name: decl.type_name, ...decl.modifiers })) continue;
		const key = decl.name;
		const site = sites.get(key);
		const source = site?.source ?? key;
		// A declare inside a nested_func is its own compilation unit — the
		// nested build plans (and binds) its own body; the enclosing plan
		// never grants it a register.
		if (site?.nested) continue;
		// Kill-switch off: names declared more than once are excluded
		// wholesale, exactly as in stage 2.
		if (!nir_site_promotion_enabled() && (source_decl_counts.get(source) ?? 0) > 1) continue;
		// A declare sharing a parameter's name (shadowing or not) keeps the
		// conservative exclusion — the pre-stage-3 model never promoted
		// either name there.
		if (param_names.has(source)) continue;
		if (traffic.ref_arg_names.has(key)) continue;
		if (address_taken.has(key)) continue;
		const r = traffic.variables.get(key);
		if (!r || r.reads < 1) continue;
		const is_float = ALL_FLOAT_TYPES.includes(decl.type_name);
		const f = facts.get(key);
		const loop_invariant_hot =
			!is_float &&
			f !== undefined &&
			f.loop_blocked &&
			r.weighted_reads >= LOOP_INVARIANT_MIN_WEIGHT &&
			!body_writes.has(key);
		if (r.reads < MIN_READS && !loop_invariant_hot) {
			// Low-read extension: int locals only, caller-saved-only, and
			// only with a provably call-free, loop-free-contained range.
			if (is_float) continue;
			if (!f || f.reads < 1 || f.crosses_call || f.loop_blocked) continue;
			candidates.push({
				name: key,
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
			name: key,
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
		// Source-name counts (not the renamed view's): a param whose name is
		// declared anywhere in the body stays excluded, exactly as before.
		if ((source_decl_counts.get(param.name) ?? 0) !== 0) continue;
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
	// The region computation (below) runs even with no candidates: a
	// function whose locals never promote still has borrowable pool
	// registers for its loops' receiver pins.
	const no_candidates = candidates.length === 0;

	// Hottest first — same ranking the legacy pass and the benchmarks
	// were tuned around (raw reads, then loop-weighted, V8 stable sort).
	candidates.sort((a, b) => b.reads - a.reads || b.weight - a.weight);

	// Field-pair SLP (ASM_PLAN_4): the function-level hint plan over the
	// AST (eligible = unrenamed float candidates). The lane-1 member of
	// each pair is REMOVED from the candidate walk — it lives in vN.d[1],
	// slot-synced by the emission fuses — and the walk pairs its partner
	// into (dN, dN+1) with dN+1 blocked (floats never share registers, so
	// skipping the slot index is the whole block).
	const slp_pairs: { a: string; b: string; vreg: string }[] = [];
	let slp_partner_of: Map<string, string> | undefined;
	let slp_lane_of: Map<string, string> | undefined;
	if (slp_pair_enabled() && options?.status) {
		const float_names = new Set(
			candidates
				.filter((c) => ALL_FLOAT_TYPES.includes(c.type_name) && !sites.has(c.name))
				.map((c) => c.name),
		);
		const plan = slp_pair_hints(func.statements, options.status);
		// Register only the pairs whose BOTH members are this allocator's
		// candidates; the rest (e.g. loop-body consts below the read bar)
		// stay unregistered for the loop promotion to claim.
		const registrable = plan.pairs.filter(([a, b]) => float_names.has(a) && float_names.has(b));
		slp_partner_of = new Map(registrable);
		slp_lane_of = new Map(registrable.map(([a, b]) => [b, a]));
	}

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
	// Float pairs walk FIRST (each consumes two d-slots), then everything
	// else in sorted order — the int side's relative order (and therefore
	// its allocations) is unchanged.
	const pair_first = slp_pairs_ordered(candidates, slp_partner_of);
	for (const c of no_candidates ? [] : pair_first) {
		// The lane-1 member of a planned pair gets NO register — it lives
		// in its partner's vN.d[1] (slot-synced by the emission fuses).
		if (slp_lane_of?.has(c.name)) continue;
		if (ALL_FLOAT_TYPES.includes(c.type_name)) {
			// Float side: legacy allocation, byte-stable with the old pass.
			if (d_used >= MAX_D_REGS) continue;
			const partner = slp_partner_of?.get(c.name);
			if (partner !== undefined && d_used + 1 < MAX_D_REGS) {
				// Pair: a in dN (lane 0), dN+1 blocked for the lane. The
				// lane rides callee_saved so an inline expansion's own loop
				// promotion (which clears register_allocations) cannot
				// hand it to its own local and zero the lane.
				const reg = D_POOL[d_used];
				const lane = D_POOL[d_used + 1];
				allocs.set(c.name, reg);
				const site = sites.get(c.name);
				if (site) site_allocs.set(c.name, { name: site.source, reg });
				occupants_of(reg).add(c.name);
				callee_saved.add(reg);
				callee_saved.add(lane);
				slp_pairs.push({ a: c.name, b: partner, vreg: `v${reg.slice(1)}` });
				d_used += 2;
				continue;
			}
			if (d_used >= MAX_D_REGS) continue;
			const reg = D_POOL[d_used++];
			allocs.set(c.name, reg);
			const site = sites.get(c.name);
			if (site) site_allocs.set(c.name, { name: site.source, reg });
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
				const callee_cap = nir_callee_pool_extended() ? MAX_X_CALLEE : 4;
				if (is_callee && x_callee_used >= callee_cap) continue;
				allocs.set(c.name, reg);
				{
					const site = sites.get(c.name);
					if (site) site_allocs.set(c.name, { name: site.source, reg });
				}
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
			{
				const site = sites.get(c.name);
				if (site) site_allocs.set(c.name, { name: site.source, reg });
			}
			occupants.add(c.name);
			break;
		}
	}
	// ------------------------------------------------------------------
	// Region-scoped pool claims (ASM_PLAN_5): pool registers whose every
	// function-wide occupant is dead throughout a loop's blocks are FREE
	// inside that loop. The emitter borrows them around the loop body
	// (spilling/restoring the displaced occupants through their slots) —
	// the register then serves as a region-pinned Buffer data pointer, so
	// the receiver-path derivation runs once per LOOP instead of once per
	// iteration. Occupant liveness membership is from the same renamed
	// CFG the assignment used; occupants without a resolvable source name
	// refuse the register (the emitter's spill needs their slots).
	const region_free: {
		node: BaseNode;
		pins: {
			reg: string;
			displaced: { name: string; key: string; type_name: string }[];
			dead: string[];
		}[];
		receivers: { key: string; node: BaseNode; call: BaseNode }[];
	}[] = [];
	if (region_pool_enabled()) {
		const reg_occupants = new Map<string, string[]>();
		for (const [name, reg] of allocs) {
			if (!CALLEE_SAVED_X.includes(reg) && !CALLER_SAVED_EXT_X.includes(reg)) continue;
			const list = reg_occupants.get(reg);
			if (list) list.push(name);
			else reg_occupants.set(reg, [name]);
		}
		for (const loop of analysis.loop_list) {
			const node = cfg.loop_headers.get(loop.header);
			if (!node) continue;
			// Nesting-complete body (see region_loop_blocks): the analyzed
			// set can miss nested blocks, and every check below must see
			// them — a nested-live occupant or a nested foreign write is
			// otherwise invisible to the outer bracket.
			const region_blocks = region_loop_blocks(
				cfg,
				analysis.dominance,
				loop.header,
				loop.blocks,
				analysis.loop_list,
			);
			const decl_types = new Map<string, string>();
			for (const d of traffic.decls) decl_types.set(d.name, d.type_name);
			const pins: {
				reg: string;
				displaced: { name: string; key: string; type_name: string }[];
				dead: string[];
			}[] = [];
			// Callee-saved first (prologue-paid, call-proof), then the
			// caller-saved extension pool (zero prologue cost, but
			// caller-saved: only sound in loops with no real call — the
			// refuse gate below drops those entries anyway — and ext pins
			// never join plan.callee_saved, so no prologue save is emitted
			// for them; exclusion rides nir_caller_saved_claimed instead).
			for (const reg of [...CALLEE_SAVED_X, ...CALLER_SAVED_EXT_X]) {
				if (pins.length >= 2) break;
				const occupants = reg_occupants.get(reg) ?? [];
				// Unoccupied registers are trivially borrowable (nothing to
				// spill); occupied ones need EVERY occupant dead in the loop
				// (block-membership disjointness from the same renamed CFG
				// the assignment used — a boundary-live occupant is a member
				// of a loop block and refuses the register).
				//
				// Shared registers (N non-interfering ranges, N values) borrow
				// through a SINGLE home slot — the first plain occupant's. At
				// most one occupant can need the entry value after the loop (a
				// second live-across occupant would be live at the same
				// boundary point and interfere with the first, so it cannot
				// share the register — and any boundary-live occupant is a
				// member and refuses above). The entry spill therefore saves
				// exactly the value the exit reload must restore; every other
				// occupant is dead across the bracket, so leaving their home
				// slots untouched is coherent. (The edigits receipt's N-slot
				// spill clobbered every sharer's home with one value; the
				// single-slot round-trip is its fix.) Site-keyed occupants
				// (ambiguous identity) can never supply the home slot, but no
				// longer veto the register — only the displaced occupant's
				// slot round-trips.
				let free = true;
				const displaced: { name: string; key: string; type_name: string }[] = [];
				const dead: string[] = [];
				for (const key of occupants) {
					const members = analysis.block_members.get(key);
					if (members && [...members].some((b) => region_blocks.has(b))) {
						free = false;
						break;
					}
					dead.push(key);
					if (displaced.length > 0) continue;
					const source = sites.get(key)?.source ?? key;
					if (source.includes("@")) continue;
					const type_name = decl_types.get(key) ?? "";
					// The emitter pre-allocates an 8-byte slot for the spill;
					// anything else (floats ride d-regs; unknown types are
					// refused) cannot be round-tripped safely.
					if (!type_name || type_name === "float" || type_name === "double") continue;
					displaced.push({ name: source, key, type_name });
				}
				if (!free) continue;
				// Occupied registers need a home slot for the round-trip;
				// unoccupied ones borrow with nothing to spill.
				if (occupants.length > 0 && displaced.length === 0) continue;
				pins.push({ reg, displaced, dead });
			}
			if (pins.length === 0) continue;
			// Loop receiver collection: Buffer fast-path accessor calls
			// whose receiver is a plain name or one field hop — the shapes
			// buffer_cache_key pins. Any real (non-call-free-refined) call
			// or a write of a receiver ROOT inside the loop refuses the
			// pins (the receiver cell could be reallocated).
			const receivers = new Map<string, { node: BaseNode; call: BaseNode }>();
			let refuse = false;
			const seen = new Set<unknown>();
			const collect = (node: unknown): void => {
				if (!node || typeof node !== "object" || refuse || seen.has(node)) return;
				seen.add(node);
				if (Array.isArray(node)) {
					for (const e of node) collect(e);
					return;
				}
				if (typeof (node as { node_type?: string }).node_type !== "string") return;
				const n = node as BaseNode;
				if (n.node_type === "access") {
					const acc = n as AccessNode;
					const call = acc.access;
					if (call && call.node_type === "access_func" && BUFFER_PIN_ACCESSORS.has(call.name)) {
						const receiver = acc.target;
						const key =
							receiver && (receiver.node_type === "value" || receiver.node_type === "access")
								? plain_or_field_key(receiver)
								: null;
						if (key) receivers.set(key, { node: receiver, call: n });
					}
				}
				for (const v of Object.values(n)) collect(v);
			};
			/** Receiver roots written inside the loop by statements that are
			 *  NOT one of the loop's own pinned-accessor calls (whose
			 *  receiver may-defs are the accessor marshalling, not cell
			 *  writes). Any foreign write of the root refuses the key. */
			const roots_refused = new Set<string>();
			const roots_written = new Set<string>();
			for (const bId of region_blocks) {
				const b = cfg.blocks[bId];
				if (!b) continue;
				for (const s of b.stmts) {
					// The statement's own pinned-accessor receiver roots (plus the
					// raw stable family — BigInt get/set/get_at/set_at/data_ptr
					// on a BigInt-typed receiver — whose may-defs are likewise
					// marshalling, never a rewire).
					const own_roots = new Set<string>();
					const scan_own = (n: unknown): void => {
						if (!n || typeof n !== "object" || roots_refused.has("")) return;
						if (Array.isArray(n)) {
							for (const e of n) scan_own(e);
							return;
						}
						if (typeof (n as { node_type?: string }).node_type !== "string") return;
						const a = n as AccessNode;
						const call = a.access;
						if (call && call.node_type === "access_func" && marshalling_accessor(call.name)) {
							if (BUFFER_PIN_ACCESSORS.has(call.name) || receiver_is_bigint(a.target)) {
								const key = plain_or_field_key(a.target);
								if (key) own_roots.add(key.split(".")[0]);
							}
						}
						for (const v of Object.values(n)) scan_own(v);
					};
					scan_own(s.node);
					for (const d of s.defs) {
						const R = d.split(".")[0];
						// A root-def is the accessor's own marshalling ONLY in
						// an eval/declare whose tree holds that accessor. An
						// ASSIGN defining the root (`root = …` or the path
						// form `root.field = …`) can rewire the pinned field
						// itself — refuse every key rooted there.
						if (s.op === "assign" || !own_roots.has(R)) {
							for (const key of receivers.keys()) {
								if (key.split(".")[0] === R) roots_refused.add(key);
							}
						} else {
							roots_written.add(R);
						}
					}
					if (
						s.has_call &&
						(!options?.status || !tree_is_call_free(s.node, options.status, new Set()))
					)
						refuse = true;
					collect(s.node);
				}
				if (b.term.t === "branch") {
					if (
						b.term.has_call &&
						(!options?.status ||
							!b.term.cond?.node ||
							!tree_is_call_free(b.term.cond.node, options.status, new Set()))
					)
						refuse = true;
					if (b.term.cond) collect(b.term.cond.node);
				}
			}
			if (refuse) continue;
			for (const key of [...receivers.keys()]) {
				if (roots_refused.has(key)) receivers.delete(key);
			}
			if (receivers.size === 0) continue;
			// Borrowed callee-saved pins MUST ride the prologue/epilogue
			// save/restore set, or the function destroys the CALLER's live
			// value in them (the layout receipt: first_child's pin clobbered
			// measure_w's x25). Extension-pool pins are caller-saved: no
			// prologue save — exclusion rides nir_caller_saved_claimed at
			// emission instead.
			for (const pin of pins) {
				if (CALLEE_SAVED_X.includes(pin.reg)) callee_saved.add(pin.reg);
			}
			region_free.push({
				node,
				pins,
				receivers: [...receivers.entries()]
					.map(([key, info]) => ({ key, node: info.node, call: info.call }))
					.slice(0, 2),
			});
		}
	}
	return {
		allocs,
		callee_saved,
		adj,
		pinned,
		source_keys,
		sites: site_allocs,
		pairs: slp_pairs,
		region_free,
	};
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
	// Tranche M (ASM_PLAN_3): the SAME loop value-numbering rewrite
	// build_body_with_cursor will run on its own lowering — applied here
	// (planning-only: no AST mutation) so the plan is computed from the
	// traffic the emitter will actually produce, and the hoisted temps can
	// earn registers. The rewrite is deterministic, so both lowerings agree
	// on every temp name and site.
	const vn = value_number_loops(nir.body, func.statements, status, false);
	const plan_body = (vn.stmts !== nir.body ? vn.stmts : nir.body) as NirStmt[];
	const plan = plan_nir_registers(
		func,
		{ ...nir, body: plan_body },
		{
			status,
			exclude_params: options?.exclude_params,
		},
	);
	if (plan.allocs.size === 0) return undefined;
	// Split plain-name bindings (live from function entry) from decl-site
	// bindings (stage 3: bound at each declare site by the emitter, so
	// same-named locals in sibling scopes never share one register).
	const plain = new Map<string, string>();
	const site_table = new Map<string, { name: string; reg: string }>();
	for (const [key, reg] of plan.allocs) {
		const site = plan.sites.get(key);
		if (site) site_table.set(key, site);
		else plain.set(key, reg);
	}
	status.register_allocations = plain.size > 0 ? plain : undefined;
	if (site_table.size > 0) status.nir_site_allocs = site_table;
	status.callee_saved_regs_used = plan.callee_saved.size > 0 ? plan.callee_saved : undefined;
	// Interference facts for loop-promotion sharing (see BuildStatus).
	status.nir_alloc_shared = { adj: plan.adj, pinned: plan.pinned, source_keys: plan.source_keys };
	// Field-pair SLP (ASM_PLAN_4): publish the plan's lane pairs for the
	// method body the caller builds right after this.
	publish_slp_pairs(plan.pairs, status);
	// Caller-saved ext claims survive inline expansions (which clear
	// register_allocations); the method caller restores the old value.
	status.nir_caller_saved_claimed = new Set(
		[...plan.allocs.values()].filter((r) => /^x1[2-5]$/.test(r)),
	);
	if (status.nir_caller_saved_claimed.size === 0) status.nir_caller_saved_claimed = undefined;
	// Region-scoped pool claims (ASM_PLAN_5): the while-dispatch bracket
	// looks up this loop by its AST node — BigInt's Knuth-D loops are
	// METHODS, planned here, not through build_function_node.
	status.nir_region_free = new Map(
		plan.region_free.map((e) => [e.node, { pins: e.pins, receivers: e.receivers }]),
	);
	if (status.nir_region_free.size === 0) status.nir_region_free = undefined;
	status.region_preseed = undefined;
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
