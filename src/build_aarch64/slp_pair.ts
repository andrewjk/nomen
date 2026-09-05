import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { is_float_type } from "../built_in_types.ts";
import type AccessFieldNode from "../nodes/AccessFieldNode.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type AccessNode from "../nodes/AccessNode.ts";
import type AssignmentNode from "../nodes/AssignmentNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type OperationNode from "../nodes/OperationNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import { resolve_at_element_addr } from "./build_access_node.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";
import { get_field_offset } from "./utils/struct_layout.ts";

/**
 * Field-pair SLP (ASM_PLAN_4 remaining step 1 — the PLAN_3 D-step-2
 * conclusion, gate passed 2026-09-05).
 *
 * Clang's nbody `advance` win is statement-level SLP within ONE struct
 * body: adjacent same-shaped float statements over ADJACENT 8-byte float
 * fields (`(x, y)`, `(vx, vy)`) become `.2d` lane pairs fed by unaligned
 * `ldur q`/`stur q` field access — NOT lanes-over-j (unprofitable for
 * AoS). This pass brings that shape class to the NIR emission path.
 *
 * ## The register model (lane residency)
 *
 * A pair (a, b) — `a` from the FIRST statement — lives in ONE vector
 * register vN: a in the LOW lane (dN — scalar-visible, a keeps its
 * normal promotion), b in the HIGH lane (vN.d[1] — deliberately NOT
 * register-promoted). AArch64 scalar writes to a D register zero the
 * upper half of the V register, so:
 *
 * - every fused register-pair WRITE (declare pair, var-assign pair)
 *   re-syncs b's frame slot (`mov d0, vN.d[1]; str d0, [x29, #slot]`) —
 *   scalar readers of b (the loop condition, third-axis statements,
 *   post-loop uses) keep reading the slot exactly as before;
 * - neither a nor b may be WRITTEN by a non-pair statement inside the
 * loop (a scalar write to dN would zero b's lane mid-flight) — the
 * hint planner enforces this by requiring every in-loop write to sit
 * inside a lane-matched adjacent statement pair;
 * - the pair's v-register is reserved against the float-tree temp
 *   allocator (`status.slp_pair_vregs`) and never v0/v1/v2 (fuse
 *   scratch) or v8 (the NEON accumulator);
 * - memory fuses (field RMW / field stores) write MEMORY, so they need
 *   no sync and impose no live-range constraints.
 *
 * Bit-exactness contract: every `.2d` lane performs the SAME IEEE
 * operation, in the same operand order, as the scalar statement it
 * replaces — multiplication commutes bitwise; loads/stores carry no FP
 * semantics. The two fused statements are adjacent and pure (no calls,
 * no branches can intervene), so no observer can interleave.
 *
 * Declines (scalar path unchanged) whenever any gate fails: registers
 * unavailable, a leaf without a promoted d-home, more than one field
 * receiver, more than 2 simultaneous temps, an offset outside `ldur`'s
 * simm9 reach, index-constant unrolling (copies share AST keys),
 * non-float fields, swaps, or an unpinnable `.at()` receiver.
 * Kill-switch `set_slp_pair_enabled(false)` restores the exact prior
 * allocation and emission (byte-identical).
 */

let slp_pair_on = true;

/** Kill-switch for A/B byte-identity tests (default: on). */
export function slp_pair_enabled(): boolean {
	return slp_pair_on;
}

export function set_slp_pair_enabled(enabled: boolean): void {
	slp_pair_on = enabled;
}

// ---------------------------------------------------------------------------
// Pair-expression analysis: two expression trees walked in lockstep.
// ---------------------------------------------------------------------------

/** ldur/stur simm9 reach for the q-form field access. */
const QOFF_MIN = -256;
const QOFF_MAX = 255;
/** Max op-tree depth (lockstep) and max simultaneous v-temps (v1/v2). */
const MAX_DEPTH = 4;
const MAX_TEMPS = 2;
/** Registers a pair may never occupy: v0/v1/v2 are the fuses' own
 * scratch. (v8 — the NEON accumulator — IS allowed as a pair home; the
 * loop builders drop a vector plan when slp_pair_vregs holds v8.) */
const FORBIDDEN_VREGS = new Set(["v0", "v1", "v2"]);

type PNode =
	| { k: "pair"; a: string; b: string; vreg: string }
	| { k: "scalar"; name: string; reg: string }
	| { k: "fieldpair"; at: AccessNode; offA: number; offB: number }
	| { k: "op"; op: "+" | "-" | "*"; left: PNode; right: PNode };

function unwrap_grouped(node: BaseNode): BaseNode {
	let n = node;
	while (n.node_type === "grouped") {
		n = (n as unknown as { value?: BaseNode }).value as BaseNode;
	}
	return n;
}

function plain_name(node: BaseNode | undefined): string | null {
	if (!node || node.node_type !== "value") return null;
	const raw = (node as ValueNode).value;
	if (typeof raw !== "string") return null;
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) ? raw : null;
}

/** A float64 field read through a fixed-array `.at(idx)` element:
 * `arr.at(idx).field` — the shape the fixed-array pipeline pins. */
interface FieldLoad {
	at: AccessNode;
	receiver_key: string;
	field: string;
	struct: string;
}

function field_load(node: BaseNode): FieldLoad | null {
	if (node.node_type !== "access") return null;
	const acc = node as AccessNode;
	if (!acc.target || acc.access.node_type !== "access_field") return null;
	const at = acc.target;
	if (at.node_type !== "access") return null;
	const at_acc = at as AccessNode;
	if (!at_acc.access || at_acc.access.node_type !== "access_func") return null;
	const af = at_acc.access as AccessFunctionCallNode;
	if (af.name !== "at" || af.params?.length !== 1) return null;
	const arr_name = at_acc.target?.node_type === "value" ? plain_name(at_acc.target) : null;
	const idx_name = plain_name(af.params[0]);
	if (!arr_name || !idx_name) return null;
	const arr_type = type_from_value_node(at_acc.target);
	if (!arr_type?.is_array || !arr_type.name) return null;
	const field_type = (acc.access as AccessFieldNode).type?.name ?? "";
	if (!is_float_type(field_type)) return null;
	return {
		at: at_acc,
		receiver_key: `${arr_name}@${idx_name}`,
		field: (acc.access as AccessFieldNode).name,
		struct: arr_type.name,
	};
}

/** Promoted float home: a d-register (never the d0/d1/d2 scratch). */
function float_home(name: string, status: BuildStatus): string | null {
	if (status.function_param_regs?.has(name)) return null;
	if (status.induction_const?.has(name)) return null;
	const reg = status.register_allocations?.get(name);
	if (!reg || !reg.startsWith("d")) return null;
	const n = parseInt(reg.slice(1), 10);
	if (Number.isNaN(n) || n < 3) return null;
	return reg;
}

/**
 * The vector register hosting the pair: `a` promoted to dN (lane 0),
 * `b` NOT register-promoted (it lives in vN.d[1], slot-synced), the two
 * planned partners, and dN+1 unclaimed by any other name (a scalar home
 * there would zero the lane on every write).
 */
function pair_vreg(a: string, b: string, status: BuildStatus): string | null {
	const hints = status.slp_pair_hints;
	if (!hints || hints.get(a) !== b || hints.get(b) !== a) return null;
	const ra = float_home(a, status);
	if (!ra) return null;
	if (status.register_allocations?.has(b)) return null;
	const n = parseInt(ra.slice(1), 10);
	const vreg = `v${n}`;
	if (FORBIDDEN_VREGS.has(vreg)) return null;
	if (n + 1 > 31) return null;
	for (const reg of status.register_allocations?.values() ?? []) {
		if (reg === `d${n + 1}`) return null;
	}
	return vreg;
}

/**
 * Walk two expression trees in lockstep. `resolve` false = shape-only
 * (hint time, before registers exist); true = every scalar leaf must
 * also resolve to its promoted home, so a successful analysis cannot
 * fail at emission. Returns null on any shape mismatch.
 */
function pair_analyze(
	a0: BaseNode,
	b0: BaseNode,
	hints: Map<string, string> | undefined,
	status: BuildStatus,
	resolve: boolean,
	depth = 0,
): PNode | null {
	if (depth > MAX_DEPTH) return null;
	const a = unwrap_grouped(a0);
	const b = unwrap_grouped(b0);

	if (a.node_type === "value" && b.node_type === "value") {
		const na = plain_name(a);
		const nb = plain_name(b);
		if (na === null || nb === null) return null;
		if (hints?.get(na) === nb && hints.get(nb) === na) {
			if (resolve) {
				const vreg = pair_vreg(na, nb, status);
				if (!vreg) return null;
				return { k: "pair", a: na, b: nb, vreg };
			}
			return { k: "pair", a: na, b: nb, vreg: "" };
		}
		if (na === nb && !hints?.has(na)) {
			if (resolve) {
				const reg = float_home(na, status);
				if (!reg) return null;
				return { k: "scalar", name: na, reg };
			}
			return { k: "scalar", name: na, reg: "" };
		}
		return null;
	}

	if (a.node_type === "access" && b.node_type === "access") {
		const fa = field_load(a);
		const fb = field_load(b);
		if (fa && fb) {
			if (fa.receiver_key !== fb.receiver_key || fa.struct !== fb.struct) return null;
			if (fa.field === fb.field) return null;
			const offA = get_field_offset(fa.struct, fa.field, status);
			const offB = get_field_offset(fb.struct, fb.field, status);
			if (offB !== offA + 8) return null;
			if (offA < QOFF_MIN || offA > QOFF_MAX) return null;
			return { k: "fieldpair", at: fa.at, offA, offB };
		}
		return null;
	}

	if (a.node_type === "op" && b.node_type === "op") {
		const oa = a as OperationNode;
		const ob = b as OperationNode;
		if (oa.op !== ob.op) return null;
		if (oa.op !== "+" && oa.op !== "-" && oa.op !== "*") return null;
		if (!oa.left_value || !oa.right_value || !ob.left_value || !ob.right_value) return null;
		const left = pair_analyze(oa.left_value, ob.left_value, hints, status, resolve, depth + 1);
		if (!left) return null;
		const right = pair_analyze(oa.right_value, ob.right_value, hints, status, resolve, depth + 1);
		if (!right) return null;
		return { k: "op", op: oa.op, left, right };
	}

	return null;
}

/** In-place instruction operand for a leaf, or null when it must
 * materialize into a temp first. */
function pnode_operand(p: PNode): string | null {
	if (p.k === "pair") return `${p.vreg}.2d`;
	if (p.k === "scalar") return `v${p.reg.slice(1)}.d[0]`;
	return null;
}

/** 128-bit register name for q-form loads/stores ("v9" → "q9"). */
function qname(vreg: string): string {
	return `q${vreg.slice(1)}`;
}

/** Simultaneous v-temp count the emission allocates (monotonic v1/v2
 * counter): every NON-root fieldpair/op node materializes into one. */
function temps_needed(p: PNode, is_root: boolean): number {
	switch (p.k) {
		case "pair":
		case "scalar":
			return 0;
		case "fieldpair":
			return is_root ? 0 : 1;
		case "op":
			return (is_root ? 0 : 1) + temps_needed(p.left, false) + temps_needed(p.right, false);
	}
}

function count_fieldpairs(p: PNode): number {
	switch (p.k) {
		case "fieldpair":
			return 1;
		case "op":
			return count_fieldpairs(p.left) + count_fieldpairs(p.right);
		default:
			return 0;
	}
}

/** Find the (at most one, by the fuse gates) field receiver and pin it.
 * A miss that cannot pin emits only the plain `.at()` derivation (no
 * cache/claim mutation), which the caller rolls back on decline; a
 * successful fill both emits and claims — after it, emission cannot
 * fail. Returns null when the receiver cannot pin (decline). */
function pin_field_receiver(p: PNode, status: BuildStatus): string | null {
	let found: AccessNode | null = null;
	const scan = (n: PNode): void => {
		if (n.k === "fieldpair") {
			found = n.at;
		} else if (n.k === "op") {
			scan(n.left);
			scan(n.right);
		}
	};
	scan(p);
	if (!found) return "x0"; // no field access — no receiver to pin
	return resolve_at_element_addr(found, status) ?? null;
}

/**
 * Re-sync b's frame slot after a fused register-pair write: scalar
 * readers of b (which has no register home) keep loading the slot. The
 * slot is allocated on demand at the pair's definition — b's own declare
 * builder never runs (the fuse consumed it), so this is the only site
 * that materializes it (at exactly the position b's declare would have).
 */
function sync_lane1(vreg: string, b: string, status: BuildStatus): void {
	let slot = status.stack_offsets?.get(b);
	if (slot === undefined) {
		slot = allocate_stack_space(status, 8, 8);
		if (!status.stack_offsets) status.stack_offsets = new Map();
		status.stack_offsets.set(b, slot);
	}
	status.code += `mov v0.d[0], ${vreg}.d[1]\n`;
	status.code += `str d0, [x29, #${slot}]\n`;
}

/** Build a pair expression into `dest` (a v-temp or pair v-register).
 * The receiver must already be pinned (pin_field_receiver succeeded).
 * Emission forms follow the asm-IR contract: arrangement-suffixed
 * vector registers (`vN.2d`), by-element `vN.d[0]`, q-form for the
 * unscaled loads/stores. */
function emit_pnode(p: PNode, dest: string, temps: { n: number }, status: BuildStatus): void {
	switch (p.k) {
		case "fieldpair": {
			const base = resolve_at_element_addr(p.at, status)!;
			status.code += `ldur ${qname(dest)}, [${base}, #${p.offA}]\n`;
			return;
		}
		case "pair":
			status.code += `fmov ${dest}.2d, ${p.vreg}.2d\n`;
			return;
		case "scalar":
			status.code += `dup ${dest}.2d, v${p.reg.slice(1)}.d[0]\n`;
			return;
		case "op": {
			const lop = pnode_operand(p.left);
			const rop = pnode_operand(p.right);
			// By-element (indexed) operands encode only as the FINAL
			// source. Commutative ops swap a left broadcast to the right
			// (bitwise identical); a left broadcast under subtraction
			// materializes via dup first (one extra temp).
			let lstr: string | null = lop;
			let rstr: string | null = rop;
			let dup_left = false;
			if (lop && /\[\d+\]$/.test(lop)) {
				if (rop && !/\[\d+\]$/.test(rop)) {
					if (p.op !== "-") {
						[lstr, rstr] = [rstr, lstr];
					} else {
						dup_left = true;
					}
				} else if (rop) {
					dup_left = true; // both broadcast — dup the left
				}
			}
			if (dup_left) {
				const reg = (p.left as { k: "scalar"; name: string; reg: string }).reg;
				const tmp = `v${temps.n++}`;
				status.code += `dup ${tmp}.2d, v${reg.slice(1)}.d[0]\n`;
				lstr = `${tmp}.2d`;
			}
			if (!lstr) {
				const tmp = `v${temps.n++}`;
				lstr = `${tmp}.2d`;
				emit_pnode(p.left, tmp, temps, status);
			}
			if (!rstr) {
				const tmp = `v${temps.n++}`;
				rstr = `${tmp}.2d`;
				emit_pnode(p.right, tmp, temps, status);
			}
			const mn = p.op === "+" ? "fadd" : p.op === "-" ? "fsub" : "fmul";
			status.code += `${mn} ${dest}.2d, ${lstr}, ${rstr}\n`;
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Hint planning (runs inside promote_loop_locals, before allocation).
// ---------------------------------------------------------------------------

function pairable_float_declare(d: BaseNode | undefined): DeclarationNode | null {
	if (!d || d.node_type !== "declare") return null;
	const decl = d as DeclarationNode;
	const t = decl.type?.name ?? "";
	if (!is_float_type(t)) return null;
	if (!decl.value) return null;
	if (typeof decl.name !== "string" || decl.name === "") return null;
	return decl;
}

/** Nested statement lists of one statement (loops, if branches,
 * switch/match arms) plus the while/for condition/update expression
 * trees (scalar reads there are slot-based — fine — but writes never
 * occur, so only the lists matter for the write gate). Note while/for
 * carry a plain `statements` array, while if/switch/match arms are
 * BranchNode blocks. */
function child_stmt_lists(s: BaseNode): BaseNode[][] {
	const out: BaseNode[][] = [];
	const n = s as unknown as Record<string, unknown>;
	const push_block = (v: unknown): void => {
		const stmts = (v as { statements?: BaseNode[] } | undefined)?.statements;
		if (Array.isArray(stmts) && stmts.length > 0) out.push(stmts);
	};
	switch (s.node_type) {
		case "while":
		case "for": {
			const stmts = n.statements;
			if (Array.isArray(stmts) && stmts.length > 0) out.push(stmts as BaseNode[]);
			return out;
		}
		case "if":
			push_block(n.if_branch);
			push_block(n.else_branch);
			return out;
		case "switch":
		case "match": {
			const cases = (n.cases ?? []) as Array<{ branch?: { statements?: BaseNode[] } }>;
			for (const c of cases) push_block(c.branch);
			push_block(n.else_branch);
			return out;
		}
		default:
			return out;
	}
}

/** Whether the assign writes the plain name (any operator shape). */
function assigns_name(stmt: BaseNode, name: string): boolean {
	if (stmt.node_type !== "assign") return false;
	const target = (stmt as AssignmentNode).left_value;
	return plain_name(target) === name;
}

/**
 * The write gate: every assignment to `a` or `b` anywhere in the loop's
 * recursive statement tree must sit inside a lane-matched adjacent
 * ASSIGNMENT pair (or be one of the pair's own two declares). A scalar
 * write to dN would zero vN's high lane mid-flight; a scalar write to
 * b's slot would diverge from the register lane.
 */
function writes_pair_safe(
	name_a: string,
	name_b: string,
	decl_a: BaseNode,
	decl_b: BaseNode,
	hints: Map<string, string>,
	status: BuildStatus,
	statements: BaseNode[],
): boolean {
	const ok = (stmts: BaseNode[]): boolean => {
		for (let i = 0; i < stmts.length; i++) {
			const s = stmts[i]!;
			if ((s !== decl_a && s !== decl_b && assigns_name(s, name_a)) || assigns_name(s, name_b)) {
				// Must be covered by a lane-matched adjacent assign pair.
				const prev = stmts[i - 1];
				const next = stmts[i + 1];
				const rhs = (s as AssignmentNode).right_value!;
				const covered =
					(next &&
						next.node_type === "assign" &&
						(next as AssignmentNode).operator === undefined &&
						pair_analyze(rhs, (next as AssignmentNode).right_value!, hints, status, false) !==
							null) ||
					(prev &&
						prev.node_type === "assign" &&
						(prev as AssignmentNode).operator === undefined &&
						pair_analyze((prev as AssignmentNode).right_value!, rhs, hints, status, false) !==
							null);
				if (!covered) {
					return false;
				}
			}
			for (const child of child_stmt_lists(s)) {
				if (!ok(child)) return false;
			}
		}
		return true;
	};
	return ok(statements);
}

/**
 * The partner map for adjacent float declare pairs whose initializers
 * lane-match (shape-only analysis — registers do not exist yet), gated
 * on the write gate. Two passes: pass one collects shape-valid
 * candidates (carrying the accumulated map so a pair may consume an
 * earlier pair's names as leaves — nbody: dx/dy read bi_x/bi_y); pass
 * two re-verifies every candidate's write gate against the FULL
 * candidate set (a candidate's own partnership counts —
 * `vx = vx - dx*m` covering vx's write needs the (vx,vy) pair itself),
 * dropping to a fixpoint.
 *
 * Returns the bidirectional hints map plus the ORDERED pairs (a = the
 * first statement's name — the lane-0 member). The scan is
 * register-blind: the CALLER filters to pairs it can register (both
 * members among its own candidates) — pairs below this scope's read
 * bar stay unregistered for an inner scope (loop promotion) to claim.
 * Names already hinted on `status.slp_pair_hints` (a registered outer
 * plan) are never re-paired.
 *
 * Group-continuation lookahead: source declares arrive in groups (x,
 * y, z / vx, vy, vz), and text-adjacent statements from DIFFERENT
 * groups can still be field-adjacent (bi_z @z, vx @vx). When the
 * candidate's FIRST member could have paired with its own PREVIOUS
 * statement (a shape-valid (prev, a) — skipped only because prev is
 * taken), a is a group continuation: skip (a, b) so b pairs with its
 * natural next (vx with vy, not bi_z with vx).
 */
export function slp_pair_hints(
	statements: BaseNode[],
	status: BuildStatus,
): { hints: Map<string, string>; pairs: [string, string][] } {
	const hints = new Map<string, string>();
	const pairs: [string, string][] = [];
	interface Candidate {
		a: string;
		b: string;
		decl_a: BaseNode;
		decl_b: BaseNode;
	}
	const candidates: Candidate[] = [];
	const taken = status.slp_pair_hints;
	const visit_list = (stmts: BaseNode[]): void => {
		for (let i = 0; i < stmts.length; i++) {
			const da = pairable_float_declare(stmts[i]);
			const db = da ? pairable_float_declare(stmts[i + 1]) : null;
			if (
				da &&
				db &&
				da.name !== db.name &&
				!hints.has(da.name) &&
				!hints.has(db.name) &&
				!taken?.has(da.name) &&
				!taken?.has(db.name) &&
				pair_analyze(da.value!, db.value!, hints, status, false) !== null
			) {
				const prev = i > 0 ? pairable_float_declare(stmts[i - 1]) : null;
				const is_continuation =
					prev !== null &&
					hints.has(prev.name) &&
					pair_analyze(prev.value!, da.value!, hints, status, false) !== null;
				if (!is_continuation) {
					hints.set(da.name, db.name);
					hints.set(db.name, da.name);
					pairs.push([da.name, db.name]);
					candidates.push({ a: da.name, b: db.name, decl_a: stmts[i]!, decl_b: stmts[i + 1]! });
				}
			}
			for (const child of child_stmt_lists(stmts[i]!)) visit_list(child);
		}
	};
	visit_list(statements);

	// Fixpoint: drop candidates whose write gate fails against the
	// current accepted set (their own partnership included).
	let changed = true;
	while (changed) {
		changed = false;
		for (const c of [...candidates]) {
			if (!writes_pair_safe(c.a, c.b, c.decl_a, c.decl_b, hints, status, statements)) {
				hints.delete(c.a);
				hints.delete(c.b);
				const idx = pairs.findIndex(([x, y]) => x === c.a && y === c.b);
				if (idx >= 0) pairs.splice(idx, 1);
				candidates.splice(candidates.indexOf(c), 1);
				changed = true;
			}
		}
	}
	return { hints, pairs };
}

/**
 * Loop-entry residency fill for a live-in b (declared OUTSIDE this
 * loop, its slot holding the incoming value): pack the slot into
 * vN.d[1] so pair reads inside the loop see the old value. Body-declared
 * b's need nothing (the pair declare defines the lane before any read).
 */
export function slp_pair_entry_pack(vreg: string, b: string, status: BuildStatus): void {
	const slot = status.stack_offsets?.get(b);
	if (slot === undefined) return;
	status.code += `ldr d0, [x29, #${slot}]\n`;
	status.code += `mov ${vreg}.d[1], v0.d[0]\n`;
}

export type SlpPair = { a: string; b: string; vreg: string };

/** Publish an allocator's lane pairs onto the status the emission fuses
 * consult: the bidirectional hints map plus the reserved v-registers
 * (the float-tree temp pool skips reserved low halves; a NEON vector
 * plan is dropped when v8 hosts a pair). */
export function publish_slp_pairs(pairs: SlpPair[] | undefined, status: BuildStatus): void {
	if (!pairs || pairs.length === 0) return;
	if (!status.slp_pair_hints) status.slp_pair_hints = new Map();
	if (!status.slp_pair_vregs) status.slp_pair_vregs = new Set();
	for (const p of pairs) {
		status.slp_pair_hints.set(p.a, p.b);
		status.slp_pair_hints.set(p.b, p.a);
		status.slp_pair_vregs.add(p.vreg);
	}
}

// ---------------------------------------------------------------------------
// Fuses (called from emit_stmt_dispatch).
// ---------------------------------------------------------------------------

/** Declare-pair fuse: two adjacent float declares — `a` promoted (dN),
 * `b` its lane partner — with lane-isomorphic initializers. The declare
 * builder's float fast path emits only the initializer ops, so the
 * fused emission is the .2d op sequence plus b's slot sync. */
function try_declare_pair(
	ast_a: BaseNode,
	ast_b: BaseNode,
	swap_a: boolean,
	swap_b: boolean,
	status: BuildStatus,
): boolean {
	const da = pairable_float_declare(ast_a);
	const db = pairable_float_declare(ast_b);
	if (!da || !db) return false;
	if (swap_a || swap_b) return false;
	const dest = pair_vreg(da.name, db.name, status);
	if (!dest) return false;
	const root = pair_analyze(da.value!, db.value!, status.slp_pair_hints, status, true);
	if (!root) return false;
	if (temps_needed(root, true) > MAX_TEMPS) return false;
	if (count_fieldpairs(root) > 1) return false;

	status.last_result_is_heap = false;
	if (root.k === "fieldpair") {
		const base = pin_field_receiver(root, status);
		if (!base) return false;
		status.code += `ldur ${qname(dest)}, [${base}, #${root.offA}]\n`;
		sync_lane1(dest, db.name, status);
		return true;
	}
	const base = pin_field_receiver(root, status);
	if (!base) return false;
	emit_pnode(root, dest, { n: 1 }, status);
	sync_lane1(dest, db.name, status);
	return true;
}

/** Var-assign pair fuse: `a = <expr_a>` / `b = <expr_b>` with a in dN
 * and b in vN.d[1]. When the root op reads the target pair as a direct
 * operand, the fused instruction consumes it in place (every ARM FP
 * instruction reads its sources before writing its destination, so the
 * old lanes stay readable). Writes both lanes, then syncs b's slot. */
function try_var_assign_pair(
	assign_a: AssignmentNode,
	assign_b: AssignmentNode,
	status: BuildStatus,
): boolean {
	const na = plain_name(assign_a.left_value);
	const nb = plain_name(assign_b.left_value);
	if (!na || !nb) return false;
	if (!assign_a.right_value || !assign_b.right_value) return false;
	const dest = pair_vreg(na, nb, status);
	if (!dest) return false;
	const root = pair_analyze(
		assign_a.right_value,
		assign_b.right_value,
		status.slp_pair_hints,
		status,
		true,
	);
	if (!root) return false;
	if (temps_needed(root, true) > MAX_TEMPS) return false;
	if (count_fieldpairs(root) > 1) return false;

	status.last_result_is_heap = false;
	const mn = (op: string) => (op === "+" ? "fadd" : op === "-" ? "fsub" : "fmul");
	if (root.k === "op" && root.left.k === "pair" && root.left.vreg === dest) {
		const base = pin_field_receiver(root.right, status);
		if (!base) return false;
		emit_pnode(root.right, "v1", { n: 2 }, status);
		status.code += `${mn(root.op)} ${dest}.2d, ${dest}.2d, v1.2d\n`;
		sync_lane1(dest, nb, status);
		return true;
	}
	if (root.k === "op" && root.right.k === "pair" && root.right.vreg === dest) {
		const base = pin_field_receiver(root.left, status);
		if (!base) return false;
		emit_pnode(root.left, "v1", { n: 2 }, status);
		status.code += `${mn(root.op)} ${dest}.2d, v1.2d, ${dest}.2d\n`;
		sync_lane1(dest, nb, status);
		return true;
	}
	const base = pin_field_receiver(root, status);
	if (!base) return false;
	emit_pnode(root, dest, { n: 1 }, status);
	sync_lane1(dest, nb, status);
	return true;
}

/** Field-assign pair fuse: `R.f1 = …` / `R.f2 = …` off the SAME pinned
 * `.at()` element — the RMW form (`R.f1 = R.f1 ± rest`) and the plain
 * store form (a computed or bare-pair expression). Memory-only: no
 * register-pair write, no slot sync needed. */
function try_field_assign_pair(
	assign_a: AssignmentNode,
	assign_b: AssignmentNode,
	status: BuildStatus,
): boolean {
	const ta = assign_a.left_value;
	const tb = assign_b.left_value;
	if (!ta || !tb || ta.node_type !== "access" || tb.node_type !== "access") return false;
	if (!assign_a.right_value || !assign_b.right_value) return false;
	const fa = field_load(ta);
	const fb = field_load(tb);
	if (!fa || !fb) return false;
	if (fa.receiver_key !== fb.receiver_key || fa.struct !== fb.struct) return false;
	if (fa.field === fb.field) return false;
	const offA = get_field_offset(fa.struct, fa.field, status);
	const offB = get_field_offset(fb.struct, fb.field, status);
	if (offB !== offA + 8) return false;
	if (offA < QOFF_MIN || offA > QOFF_MAX) return false;

	// RMW: rhs root reads the old field values — `<R.f1> ± <rest>`.
	const ra = unwrap_grouped(assign_a.right_value);
	const rb = unwrap_grouped(assign_b.right_value);
	if (ra.node_type === "op" && rb.node_type === "op") {
		const oa = ra as OperationNode;
		const ob = rb as OperationNode;
		if (oa.op === ob.op && (oa.op === "+" || oa.op === "-")) {
			// The old-value read must be the SAME receiver AND field as the
			// assignment target (not merely a same-named field elsewhere).
			const side_load = (n: BaseNode | undefined): FieldLoad | null =>
				n && n.node_type === "access" ? field_load(n) : null;
			const la = side_load(oa.left_value);
			const ra2 = side_load(oa.right_value);
			const lb = side_load(ob.left_value);
			const rb2 = side_load(ob.right_value);
			const same = (x: FieldLoad | null, f: FieldLoad): boolean =>
				!!x && x.receiver_key === f.receiver_key && x.field === f.field && x.struct === f.struct;
			let rest: PNode | null = null;
			let left_is_old = false;
			let reads_old = false;
			if (same(la, fa) && same(lb, fb)) {
				left_is_old = true;
				reads_old = true;
				rest = pair_analyze(oa.right_value!, ob.right_value!, status.slp_pair_hints, status, true);
			} else if (same(ra2, fa) && same(rb2, fb)) {
				reads_old = true;
				rest = pair_analyze(oa.left_value!, ob.left_value!, status.slp_pair_hints, status, true);
			} else if (same(la, fa) || same(ra2, fa) || same(lb, fb) || same(rb2, fb)) {
				// A partial old-value read (present on one side only, or
				// mismatched receiver/field) — no safe pair form.
				return false;
			}
			if (reads_old) {
				if (!rest) return false;
				if (temps_needed(rest, true) > MAX_TEMPS) return false;
				if (count_fieldpairs(rest) > 0) return false;
				const base = resolve_at_element_addr(fa.at, status);
				if (!base) return false;
				status.last_result_is_heap = false;
				status.code += `ldur q0, [${base}, #${offA}]\n`;
				emit_pnode(rest, "v1", { n: 2 }, status);
				const mn = oa.op === "+" ? "fadd" : "fsub";
				if (left_is_old) {
					status.code += `${mn} v0.2d, v0.2d, v1.2d\n`;
				} else {
					status.code += `${mn} v0.2d, v1.2d, v0.2d\n`;
				}
				status.code += `stur q0, [${base}, #${offA}]\n`;
				return true;
			}
		}
	}

	// Plain store: rhs lane-matches, no field loads inside (one receiver).
	const root = pair_analyze(
		assign_a.right_value,
		assign_b.right_value,
		status.slp_pair_hints,
		status,
		true,
	);
	if (!root) return false;
	if (count_fieldpairs(root) > 0) return false;
	if (temps_needed(root, true) > MAX_TEMPS) return false;
	const base = resolve_at_element_addr(fa.at, status);
	if (!base) return false;
	status.last_result_is_heap = false;
	if (root.k === "pair") {
		status.code += `stur ${qname(root.vreg)}, [${base}, #${offA}]\n`;
		return true;
	}
	emit_pnode(root, "v0", { n: 1 }, status);
	status.code += `stur q0, [${base}, #${offA}]\n`;
	return true;
}

/**
 * Entry point from emit_stmt_dispatch: when the cursor owns this
 * statement list and the next NIR entry is the same pure kind, attempt
 * the pair fuse. Returns the number of statements consumed (2 fused, 1
 * decline). Emits the trailing newline itself on success.
 *
 * Rollback safety: the only emission a declined fuse must undo is the
 * unpinned `.at()` derivation text from a failed receiver resolve (no
 * cache or claim state mutated on that path — see pin_field_receiver);
 * every successful pin fill commits the fuse before another gate can
 * run.
 */
export function try_emit_slp_pair(
	index: number,
	ctx_ast: readonly BaseNode[],
	ctx_stmts: readonly { kind: string }[],
	status: BuildStatus,
): number {
	if (!slp_pair_on) return 1;
	if (status.induction_const?.size) return 1;
	const kind = ctx_stmts[index]?.kind;
	if (!kind || ctx_stmts[index + 1]?.kind !== kind) return 1;
	if (kind !== "declare" && kind !== "assign") return 1;
	const ast_a = ctx_ast[index];
	const ast_b = ctx_ast[index + 1];
	if (!ast_a || !ast_b) return 1;
	if (ast_a.node_type !== kind || ast_b.node_type !== kind) return 1;

	const before = status.code.length;
	let fused = false;
	if (kind === "declare") {
		const na = ctx_stmts[index] as { decl?: { swap?: unknown } };
		const nb = ctx_stmts[index + 1] as { decl?: { swap?: unknown } };
		fused = try_declare_pair(ast_a, ast_b, !!na.decl?.swap, !!nb.decl?.swap, status);
	} else {
		const aa = ast_a as AssignmentNode;
		const ab = ast_b as AssignmentNode;
		if (aa.operator === undefined && ab.operator === undefined) {
			fused = try_field_assign_pair(aa, ab, status) || try_var_assign_pair(aa, ab, status);
		}
	}
	if (!fused) {
		status.code = status.code.slice(0, before);
		return 1;
	}
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
	return 2;
}
