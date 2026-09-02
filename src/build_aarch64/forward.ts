import type BuildStatus from "../build_c/BuildStatus.ts";
import { is_float_type, is_scalar_type } from "../built_in_types.ts";
import type { NirEmitCtx } from "../nir/emit_ctx.ts";
import type { NirExpr, NirStmt } from "../nir/nir.ts";
import { analyze_traffic, type TrafficReport } from "../nir/traffic.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type OperationNode from "../nodes/OperationNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";

/**
 * Stage 4 (ASM_PLAN_3): NIR straight-line store-to-load traffic elimination.
 *
 * The per-statement emission model materializes every local through its
 * frame slot: a declaration computes its initializer into x0 and stores it,
 * and each later read loads the slot again. When the register allocator
 * promotes the local, both halves collapse into one register — but a
 * single-read local never earns a register (no read count to justify one),
 * so its slot round trip survives in even the hottest loops. The pidigits
 * `div_to` estimate step carried exactly that shape (`d_hi`, `q_hi`,
 * `sub_lo`): `str x0, [x29, #K]` at the def, `ldr x0, [x29, #K]` at the
 * only read, with the phase-2 asm pass unable to help because the store's
 * source register is clobbered in between. The same loop's carry flags
 * (`p_mc`, `p_lo_c`) are write-only after their reader was commented out —
 * their whole cmp/cset/store tail is dead.
 *
 * Two cursor-level rewrites, both driven by one traffic walk:
 *
 * - SINGLE-USE FORWARDING: a scalar local declared exactly once, read
 *   exactly once, never written/ref/address-taken, whose initializer is a
 *   pure int expression tree, has that initializer re-emitted AT the read
 *   site (the use's NIR expression leaf is rewritten into the declaring
 *   initializer). The def then emits nothing — no store, no load. The same
 *   mechanism `top_level_consts` uses for module constants, scoped to a
 *   same-list straight-line window and gated on value stability (below).
 * - WRITE-ONLY CSET-PAIR ELISION: the tranche-B fuse shape whose flag name
 *   is never read anywhere skips the cmp/cset/store tail — the declare
 *   still builds, preserving every registration semantic.
 *
 * Soundness of forwarding = "every leaf of the re-emitted tree holds its
 * def-time value at the use site". The gates, conservative by design:
 *
 * - the use sits in the SAME statement list, after the declare, within a
 *   bounded distance, and every statement between is a declare whose own
 *   initializer is call-free (calls inline-expand, clear register maps,
 *   and can write ref-arg slots — none may intervene);
 * - no statement in the window redeclares the forwarded name or any leaf
 *   name (shadowing would retarget the use);
 * - the forwarded name occurs as a leaf EXACTLY ONCE in the entire lowered
 *   function — counting every expression position, including the ones
 *   traffic deliberately does not walk (flow arms, spawn calls, swap
 *   exprs) — so no unmodeled read can touch the never-stored slot;
 * - a window declare whose decl-site register collides with a promoted
 *   leaf's register kills the candidate (the div_to receipt: two claim
 *   systems handing one register to two live variables);
 * - the use expression is entirely call-free; the forwarded name is NOT
 *   register-promoted (promoted locals already avoid the slot) and is
 *   never a ref argument, receiver, array, or nullable;
 * - a candidate whose single use sits inside ANOTHER candidate's
 *   initializer (same list) is dropped when that other candidate actually
 *   forwarded into it: composed re-emission would emit the inner tree at
 *   the outer use site — a span the inner candidate's window never
 *   checked. The dropped candidate keeps its plain slot store, which the
 *   outer candidate's slot read needs anyway.
 *
 * Because the rewrite replaces the use's expression leaf with the init
 * subtree BEFORE emission, every downstream consumer — int-tree counting,
 * in-place operand selectors, cset operand homes — sees a plain, deeper
 * expression tree. No read path learns about forwarding at all.
 *
 * Kill-switch: `set_forwarding_enabled` (default ON; OFF restores untouched
 * NIR statements — byte-identical output). Like site promotion and the
 * cset fuse, the pass is cursor-dependent: the byte-identity harness holds
 * it OFF in both arms.
 */

let forwarding_on = true;

/** Kill-switch for A/B byte-identity tests (default: ON). */
export function forwarding_enabled(): boolean {
	return forwarding_on;
}

export function set_forwarding_enabled(enabled: boolean): void {
	forwarding_on = enabled;
}

/** Int ops whose re-emission inside an int expression tree is exact. */
const FORWARD_OPS = new Set(["+", "-", "*", "/", "<<", ">>", "&", "|", "^"]);

/** Tree budget: nodes/depth bounds keep re-emission genuinely cheaper than
 *  the store+load pair it replaces under every allocator outcome. */
const MAX_FORWARD_NODES = 4;
const MAX_FORWARD_DEPTH = 3;
/** Maximum distance (statements) between declare and use. */
const MAX_FORWARD_DISTANCE = 16;

interface PureIntExpr {
	ok: boolean;
	nodes: number;
	leaves: string[];
}

/** Pure int expression: FORWARD_OPS binaries over identifier/int-literal
 *  leaves, grouped wrappers. Calls, paths, casts, floats, comparisons —
 *  anything else — fail. */
function scan_pure_int_expr(node: BaseNode, depth: number): PureIntExpr {
	const fail: PureIntExpr = { ok: false, nodes: 0, leaves: [] };
	if (depth > MAX_FORWARD_DEPTH) return fail;
	if (node.node_type === "grouped") {
		const inner = (node as unknown as { value?: BaseNode }).value;
		if (!inner) return fail;
		return scan_pure_int_expr(inner, depth);
	}
	if (node.node_type === "value") {
		const val = (node as unknown as ValueNode).value;
		if (typeof val !== "string") return fail;
		// Identifier leaf (traffic filters the same shape), or an int literal.
		if (is_identifier_shape(val)) {
			return { ok: true, nodes: 1, leaves: [val] };
		}
		if (/^(\+|-)?\d+$/.test(val)) {
			return { ok: true, nodes: 1, leaves: [] };
		}
		return fail;
	}
	if (node.node_type === "op") {
		const op = node as OperationNode;
		if (!FORWARD_OPS.has(op.op) || !op.left_value || !op.right_value) return fail;
		const ls = scan_pure_int_expr(op.left_value, depth + 1);
		if (!ls.ok) return fail;
		const rs = scan_pure_int_expr(op.right_value, depth + 1);
		if (!rs.ok) return fail;
		const nodes = 1 + ls.nodes + rs.nodes;
		if (nodes > MAX_FORWARD_NODES) return fail;
		return { ok: true, nodes, leaves: [...ls.leaves, ...rs.leaves] };
	}
	return fail;
}

function is_identifier_shape(val: string): boolean {
	return (
		val.length > 0 &&
		!/^(\+|-)?\d+(\.\d+)?$/.test(val) &&
		!val.startsWith('"') &&
		!val.startsWith("'") &&
		val !== "true" &&
		val !== "false" &&
		val !== "null" &&
		!val.includes(".")
	);
}

/** True when the NIR expression tree contains any call-shaped node. */
function expr_has_call(e: NirExpr): boolean {
	switch (e.kind) {
		case "leaf":
			return false;
		case "binary":
			return expr_has_call(e.left) || expr_has_call(e.right);
		case "wrap":
			return e.inner ? expr_has_call(e.inner) : false;
		case "path":
			return expr_has_call(e.receiver);
		case "call":
		case "method_call":
		case "spawn":
		case "flow":
		case "other":
			return true;
		default:
			return true;
	}
}

/** Count EVERY leaf occurrence of `name` in any expression position of the
 *  statement tree — including flow arms, spawn calls, swap exprs and assign
 *  targets, which traffic deliberately does not (or does only via parity).
 *  A forwarded name's slot is never stored, so even one uncounted read
 *  would load garbage. */
function count_name_occurrences(stmts: readonly NirStmt[], name: string): number {
	let count = 0;
	const expr_walk = (e: NirExpr): void => {
		switch (e.kind) {
			case "leaf":
				if (e.name === name) count++;
				return;
			case "binary":
				expr_walk(e.left);
				expr_walk(e.right);
				return;
			case "wrap":
				if (e.inner) expr_walk(e.inner);
				return;
			case "path":
				expr_walk(e.receiver);
				return;
			case "call":
				for (const a of e.facts.args) expr_walk(a);
				return;
			case "method_call":
				expr_walk(e.receiver);
				for (const a of e.facts.args) expr_walk(a);
				return;
			case "flow":
				if (e.scrutinee) expr_walk(e.scrutinee);
				for (const arm of e.arms) {
					if (arm.condition) expr_walk(arm.condition);
					count += count_name_occurrences(arm.branch, name);
				}
				if (e.otherwise) count += count_name_occurrences(e.otherwise, name);
				return;
			case "spawn":
				expr_walk(e.call);
				return;
			case "other":
				return;
			default:
				return;
		}
	};
	const walk = (list: readonly NirStmt[]): void => {
		for (const s of list) {
			switch (s.kind) {
				case "declare":
					if (s.decl.init) expr_walk(s.decl.init);
					if (s.decl.swap) expr_walk(s.decl.swap);
					break;
				case "assign":
					expr_walk(s.target);
					expr_walk(s.rhs);
					if (s.swap) expr_walk(s.swap);
					break;
				case "eval":
					expr_walk(s.expr);
					break;
				case "if":
					expr_walk(s.cond);
					walk(s.then_branch);
					walk(s.else_branch);
					break;
				case "while":
					expr_walk(s.cond);
					walk(s.body);
					if (s.update) walk([s.update]);
					break;
				case "for":
					if (s.list) expr_walk(s.list);
					walk(s.body);
					if (s.update) walk([s.update]);
					break;
				case "switch_match":
					if (s.scrutinee) expr_walk(s.scrutinee);
					for (const arm of s.arms) {
						if (arm.condition) expr_walk(arm.condition);
						walk(arm.branch);
					}
					if (s.otherwise) walk(s.otherwise);
					break;
				case "return":
					if (s.value) expr_walk(s.value);
					break;
				case "spawn":
					expr_walk(s.call);
					break;
				case "async_block":
					walk(s.body);
					break;
				case "anon_struct":
					for (const f of s.fields) expr_walk(f.expr);
					break;
				case "nested_func":
					walk(s.body);
					break;
				default:
					break;
			}
		}
	};
	walk(stmts);
	return count;
}

/** The read-bearing expression of a statement, for use-site search. Only
 *  value positions qualify as forward uses. */
function use_expr_of(stmt: NirStmt): NirExpr | null {
	switch (stmt.kind) {
		case "declare":
			return stmt.decl.init;
		case "assign":
			return stmt.rhs;
		case "eval":
			return stmt.expr;
		case "return":
			return stmt.value;
		default:
			return null;
	}
}

type PathStep = "left" | "right" | "inner" | "receiver";

/** Find the path to a leaf naming `name` inside the expression. */
function find_leaf(e: NirExpr, name: string): PathStep[] | null {
	switch (e.kind) {
		case "leaf":
			return e.name === name ? [] : null;
		case "binary": {
			const l = find_leaf(e.left, name);
			if (l) return ["left", ...l];
			const r = find_leaf(e.right, name);
			if (r) return ["right", ...r];
			return null;
		}
		case "wrap": {
			if (!e.inner) return null;
			const i = find_leaf(e.inner, name);
			return i ? ["inner", ...i] : null;
		}
		case "path": {
			const r = find_leaf(e.receiver, name);
			return r ? ["receiver", ...r] : null;
		}
		default:
			return null;
	}
}

function child_at(e: NirExpr, step: PathStep): NirExpr | null {
	switch (e.kind) {
		case "binary":
			return step === "left" ? e.left : step === "right" ? e.right : null;
		case "wrap":
			return step === "inner" ? (e.inner ?? null) : null;
		case "path":
			return step === "receiver" ? e.receiver : null;
		default:
			return null;
	}
}

function child_with(e: NirExpr, step: PathStep, value: NirExpr): NirExpr | null {
	switch (e.kind) {
		case "binary":
			if (step === "left") return { ...e, left: value };
			if (step === "right") return { ...e, right: value };
			return null;
		case "wrap":
			if (step === "inner") return { ...e, inner: value };
			return null;
		case "path":
			if (step === "receiver") return { ...e, receiver: value };
			return null;
		default:
			return null;
	}
}

function expr_with(e: NirExpr, path: readonly PathStep[], value: NirExpr): NirExpr {
	if (path.length === 0) return value;
	const [head, ...rest] = path;
	const child = child_at(e, head);
	if (!child) return e;
	const new_child = expr_with(child, rest, value);
	return child_with(e, head, new_child) ?? e;
}

// ---- AST-side use sites (the emission mechanism) ----
//
// The emitters build from the AST nodes the NIR exprs carry (`expr.node`),
// NOT from the NIR spine — so forwarding ships as a temporary AST mutation:
// before the use statement builds, the leaf ValueNode is swapped for the
// declaring initializer; after it builds, the original child is restored.
// The swap lives exactly one statement, so every build of the body
// (standalone, inline expansion) re-validates through its own pass and
// emits exactly what its own gates sanctioned.

/** One splice into a use site: the NIR-parallel descent path from the
 *  expression root to the leaf, and the declaring initializer to splice
 *  in. A single use statement can carry several splices (two forwarded
 *  temps read by one expression — p_lo's `(q_lo*d_lo) + (p_mid<<32)`). */
export interface ForwardSplice {
	path: PathStep[];
	init: BaseNode;
}

/** One recorded use site: the AST node holding the expression root
 *  (`host[field]`) and every leaf splice within it. `field` is null when
 *  the host node IS the expression root (eval positions) and every path
 *  must then be non-empty. */
export interface ForwardUse {
	host: BaseNode;
	field: "value" | "right_value" | null;
	splices: ForwardSplice[];
}

function ast_child_at(node: BaseNode, step: PathStep): BaseNode | null {
	switch (node.node_type) {
		case "op":
			return step === "left"
				? (node as OperationNode).left_value
				: step === "right"
					? (node as OperationNode).right_value
					: null;
		case "grouped":
		case "cast":
		case "let":
			return step === "inner" ? ((node as unknown as { value?: BaseNode }).value ?? null) : null;
		case "access":
			return step === "receiver" ? (node as AccessNode).target : null;
		default:
			return null;
	}
}

function ast_child_set(node: BaseNode, step: PathStep, value: BaseNode): void {
	switch (node.node_type) {
		case "op":
			if (step === "left") (node as OperationNode).left_value = value;
			else if (step === "right") (node as OperationNode).right_value = value;
			return;
		case "grouped":
		case "cast":
		case "let":
			if (step === "inner") (node as unknown as { value?: BaseNode }).value = value;
			return;
		case "access":
			if (step === "receiver") (node as AccessNode).target = value;
			return;
	}
}

/** Apply every recorded splice for `host` (the use statement's AST node).
 *  Returns a restore thunk, or null when the host has no plan. Splices are
 *  applied outermost-first along disjoint paths, so each parent lookup sees
 *  the ORIGINAL spine; the restore replays them in reverse. */
export function apply_forward_use(
	sites: ReadonlyMap<BaseNode, ForwardUse> | undefined,
	host: BaseNode | undefined,
): (() => void) | null {
	if (!host || !sites || sites.size === 0) return null;
	const use = sites.get(host);
	if (!use || use.splices.length === 0) return null;
	const owner = use.host as unknown as Record<string, unknown>;
	// A whole-root replacement (the use expression IS the forwarded leaf)
	// is recorded alone — nothing else can splice into the same root.
	if (use.splices.length === 1 && use.splices[0].path.length === 0) {
		if (use.field === null) return null;
		const field = use.field;
		const original_root = owner[field] as BaseNode;
		owner[field] = use.splices[0].init;
		return () => {
			owner[field] = original_root;
		};
	}
	const root = use.field === null ? use.host : (owner[use.field] as BaseNode);
	const applied: { parent: BaseNode; step: PathStep; original: BaseNode }[] = [];
	for (const splice of use.splices) {
		const last = splice.path[splice.path.length - 1];
		let parent: BaseNode = root;
		for (let i = 0; i < splice.path.length - 1; i++) {
			const next = ast_child_at(parent, splice.path[i]);
			if (!next) return null;
			parent = next;
		}
		const original = ast_child_at(parent, last);
		if (!original) return null;
		applied.push({ parent, step: last, original });
		ast_child_set(parent, last, splice.init);
	}
	return () => {
		for (const { parent, step, original } of applied.reverse()) {
			ast_child_set(parent, step, original);
		}
	};
}

function stmt_with_use_expr(stmt: NirStmt, value: NirExpr): NirStmt {
	switch (stmt.kind) {
		case "declare":
			return { ...stmt, decl: { ...stmt.decl, init: value } };
		case "assign":
			return { ...stmt, rhs: value };
		case "eval":
			return { ...stmt, expr: value };
		case "return":
			return { ...stmt, value };
		default:
			return stmt;
	}
}

/** Every assign target name in the whole statement tree (traffic counts
 *  targets as reads for parity — the actual writes need their own scan). */
function collect_assign_targets(stmts: readonly NirStmt[], into: Set<string>): void {
	for (const s of stmts) {
		switch (s.kind) {
			case "assign": {
				let e = s.target;
				while (e.kind === "wrap") e = e.inner ?? e;
				if (e.kind === "leaf" && e.name) into.add(e.name);
				else if (e.kind === "path") {
					let r = e.receiver;
					while (r.kind === "wrap") r = r.inner ?? r;
					if (r.kind === "leaf" && r.name) into.add(r.name);
				}
				break;
			}
			case "if":
				collect_assign_targets(s.then_branch, into);
				collect_assign_targets(s.else_branch, into);
				break;
			case "while":
				collect_assign_targets(s.body, into);
				break;
			case "for":
				into.add(s.item_name);
				collect_assign_targets(s.body, into);
				break;
			case "switch_match":
				for (const a of s.arms) collect_assign_targets(a.branch, into);
				if (s.otherwise) collect_assign_targets(s.otherwise, into);
				break;
			case "async_block":
				collect_assign_targets(s.body, into);
				break;
			case "nested_func":
				collect_assign_targets(s.body, into);
				break;
			default:
				break;
		}
	}
}

/** Names whose every mention is a write: zero true reads, no address
 *  escape, no ref marshalling. Traffic's parity rule counts assign TARGETS
 *  as reads, so targets are subtracted explicitly — a flag that is only
 *  ever declared-and-assigned (`p_mc = 0; ...; p_mc = 1`) is dead weight.
 *  (Cset-pair elision consults this.) */
function compute_write_only_names(stmts: readonly NirStmt[], traffic: TrafficReport): Set<string> {
	const targets = new Set<string>();
	collect_assign_targets(stmts, targets);
	const dead = new Set<string>();
	for (const [name, t] of traffic.variables) {
		if (!t.address_taken && !traffic.ref_arg_names.has(name)) {
			const true_reads = t.reads - (targets.has(name) ? 1 : 0);
			if (true_reads <= 0) dead.add(name);
		}
	}
	return dead;
}

/** Site-promoted register for `name`, if the planner gave the name's only
 *  declaration a decl-site register. */
function site_reg_for(name: string, status: BuildStatus): string | null {
	for (const site of status.nir_site_allocs?.values() ?? []) {
		if (site.name === name) return site.reg;
	}
	return null;
}

/** Registers the re-emitted tree will read its leaves from: plain
 *  function-wide bindings plus declare-site bindings. */
function leaf_regs(leaves: readonly string[], status: BuildStatus): Set<string> {
	const regs = new Set<string>();
	for (const leaf_name of leaves) {
		const plain = status.register_allocations?.get(leaf_name);
		if (plain) regs.add(plain);
		const site = site_reg_for(leaf_name, status);
		if (site) regs.add(site);
	}
	return regs;
}

/** The nested statement lists of one statement, after its own list has
 *  been processed (recursion happens on the REWRITTEN statements). */
function nested_lists(stmt: NirStmt): readonly (readonly NirStmt[])[] {
	switch (stmt.kind) {
		case "if":
			return [stmt.then_branch, stmt.else_branch];
		case "while":
			return [stmt.body];
		case "for":
			return [stmt.body];
		case "switch_match": {
			const lists: readonly (readonly NirStmt[])[] = stmt.otherwise
				? [...stmt.arms.map((a) => a.branch), stmt.otherwise]
				: stmt.arms.map((a) => a.branch);
			return lists;
		}
		case "async_block":
			return [stmt.body];
		case "nested_func":
			return [stmt.body];
		default:
			return [];
	}
}

function with_nested_list(stmt: NirStmt, index: number, list: readonly NirStmt[]): NirStmt {
	switch (stmt.kind) {
		case "if":
			return index === 0
				? { ...stmt, then_branch: list as NirStmt[] }
				: { ...stmt, else_branch: list as NirStmt[] };
		case "while":
			return { ...stmt, body: list as NirStmt[] };
		case "for":
			return { ...stmt, body: list as NirStmt[] };
		case "switch_match": {
			const arms = [...stmt.arms];
			if (index < arms.length) {
				arms[index] = { ...arms[index], branch: list as NirStmt[] };
				return { ...stmt, arms };
			}
			return { ...stmt, otherwise: list as NirStmt[] };
		}
		case "async_block":
			return { ...stmt, body: list as NirStmt[] };
		case "nested_func":
			return { ...stmt, body: list as NirStmt[] };
		default:
			return stmt;
	}
}

/** Candidate gates that don't depend on a located use. */
function forward_candidate(
	stmt: NirStmt,
	root: readonly NirStmt[],
	traffic: TrafficReport,
	write_only: ReadonlySet<string>,
	status: BuildStatus,
	hidden_reads: ReadonlySet<string>,
): { name: string; scan: PureIntExpr } | null {
	if (stmt.kind !== "declare") return null;
	const decl = stmt.decl;
	const name = decl.name;
	if (!name || !is_identifier_shape(name)) return null;
	// A write-only flag is the elision path's business, not forwarding's.
	if (write_only.has(name)) return null;
	// Scalar int-typed, no modifiers. Floats/arrays/refs/nullables stay on
	// the slot path wholesale.
	const type_name = decl.type?.name ?? "";
	if (!type_name || is_float_type(type_name) || !is_scalar_type(type_name)) return null;
	if (
		decl.modifiers.is_array ||
		decl.modifiers.is_ref ||
		decl.modifiers.is_nullable ||
		decl.modifiers.is_view
	) {
		return null;
	}
	if (traffic.decl_counts.get(name) !== 1) return null;
	if (traffic.ref_arg_names.has(name)) return null;
	const t = traffic.variables.get(name);
	if (!t || t.address_taken) return null;
	// Exactly one read — and NOT promoted (promoted locals already avoid
	// the slot round trip; reworking the planner's decisions is out of
	// scope). The traffic parity rule counts assign targets as reads, so a
	// written local can't sneak through `reads === 1`.
	if (t.reads !== 1) return null;
	if (status.register_allocations?.has(name)) return null;
	if (site_reg_for(name, status)) return null;
	// The name must occur as a leaf EXACTLY once in the entire lowered
	// function — every expression position, including flow/spawn/swap
	// positions traffic skips. One occurrence = the use this pass will
	// rewrite; any more would read the never-stored slot.
	if (count_name_occurrences(root, name) !== 1) return null;
	// A hoisted compute reading the name is an uncounted read of the
	// never-stored slot.
	if (hidden_reads.has(name)) return null;
	// Bounded pure int initializer.
	if (!decl.init) return null;
	const scan = scan_pure_int_expr(decl.init.node, 0);
	if (!scan.ok) return null;
	return { name, scan };
}

/** Identifiers read by checker-hoisted allocation computes attached to the
 *  statement ASTs (`_param_N = <expr>` — the lowered exprs only see the
 *  spliced `_param_N` leaf, so these reads are invisible to NIR traffic).
 *  Structural walk over the initializer ASTs: every ValueNode inside one is
 *  an expression read. Over-collection is safe — a spurious name only
 *  shrinks eligibility. */
function collect_hidden_reads(stmts: readonly NirStmt[], into: Set<string>): void {
	const visit = (n: unknown): void => {
		if (!n || typeof n !== "object") return;
		if (Array.isArray(n)) {
			for (const item of n) visit(item);
			return;
		}
		const obj = n as Record<string, unknown>;
		if (typeof obj.node_type !== "string") return;
		if (obj.node_type === "value" && typeof obj.value === "string") {
			if (is_identifier_shape(obj.value)) into.add(obj.value);
			return;
		}
		for (const key of Object.keys(obj)) {
			if (key === "type" || key === "allocations") continue;
			visit(obj[key]);
		}
	};
	const walk = (list: readonly NirStmt[]): void => {
		for (const s of list) {
			const allocs = (s.node as { allocations?: unknown[] } | null | undefined)?.allocations;
			if (Array.isArray(allocs)) {
				for (const alloc of allocs) {
					visit((alloc as { value?: unknown }).value);
				}
			}
			for (const nested of nested_lists(s)) walk(nested);
		}
	};
	walk(stmts);
}

/** Map the use statement onto the AST node + field that own its value
 *  expression root. Eval positions have no owning field — the host IS the
 *  root — so they require a non-empty descent path. */
function record_use_site(
	use_stmt: NirStmt,
	path: PathStep[],
	init: BaseNode,
	use_sites: Map<BaseNode, ForwardUse>,
): void {
	let host: BaseNode;
	let field: "value" | "right_value" | null;
	switch (use_stmt.kind) {
		case "declare":
			host = use_stmt.decl.node;
			field = "value";
			break;
		case "assign":
			host = use_stmt.node;
			field = "right_value";
			break;
		case "eval":
			if (path.length === 0) return;
			host = use_stmt.expr.node;
			field = null;
			break;
		case "return":
			if (!use_stmt.value) return;
			host = use_stmt.node;
			field = "value";
			break;
		default:
			return;
	}
	const existing = use_sites.get(host);
	if (existing) {
		existing.splices.push({ path, init });
	} else {
		use_sites.set(host, { host, field, splices: [{ path, init }] });
	}
}

/**
 * Run once per published emission cursor, before any statement emits:
 * rewrite single-use forwards and report write-only names for the cset
 * fuse. Returns the (possibly identical) statement list plus the
 * write-only name set.
 */
export function prepare_nir_forwarding(
	stmts: readonly NirStmt[],
	status: BuildStatus,
): {
	stmts: readonly NirStmt[];
	write_only: ReadonlySet<string>;
	use_sites: ReadonlyMap<BaseNode, ForwardUse>;
	forward_defs: ReadonlySet<BaseNode>;
} {
	if (!forwarding_enabled()) {
		return { stmts, write_only: new Set(), use_sites: new Map(), forward_defs: new Set() };
	}
	const traffic = analyze_traffic({
		name: "",
		label_name: undefined,
		params: [],
		body: stmts as NirStmt[],
		unknown_kinds: new Set<string>(),
	});
	// Hidden reads (hoisted computes) both kill write-only eligibility and
	// disqualify themselves as forward candidates — a name they read must
	// keep its slot stores.
	const write_only = compute_write_only_names(stmts, traffic);
	const hidden_reads = new Set<string>();
	collect_hidden_reads(stmts, hidden_reads);
	for (const name of hidden_reads) write_only.delete(name);
	const use_sites = new Map<BaseNode, ForwardUse>();
	const forward_defs = new Set<BaseNode>();
	const rewritten = process_list(
		stmts,
		stmts,
		traffic,
		write_only,
		status,
		hidden_reads,
		use_sites,
		forward_defs,
	);
	return { stmts: rewritten, write_only, use_sites, forward_defs };
}

function process_list(
	list: readonly NirStmt[],
	root: readonly NirStmt[],
	traffic: TrafficReport,
	write_only: ReadonlySet<string>,
	status: BuildStatus,
	hidden_reads: ReadonlySet<string>,
	use_sites: Map<BaseNode, ForwardUse>,
	forward_defs: Set<BaseNode>,
): readonly NirStmt[] {
	const out = [...list];
	// Names whose INIT received a forwarded tree: those declares must not
	// forward themselves (composition guard — see module comment).
	const composed_inits = new Set<string>();

	for (let i = 0; i < out.length; i++) {
		const stmt = out[i];
		const cand = forward_candidate(stmt, root, traffic, write_only, status, hidden_reads);
		if (!cand || stmt.kind !== "declare") {
			continue;
		}
		const { name, scan } = cand;

		// Locate the single use in THIS list, after the declare.
		let use_index = -1;
		let use_path: PathStep[] = [];
		for (let j = i + 1; j <= Math.min(out.length - 1, i + MAX_FORWARD_DISTANCE); j++) {
			const uexpr = use_expr_of(out[j]);
			if (!uexpr) continue;
			const found = find_leaf(uexpr, name);
			if (found) {
				use_index = j;
				use_path = found;
				break;
			}
		}
		if (use_index < 0) continue;
		const use_stmt = out[use_index];

		// The use expression must be entirely call-free (an intervening
		// inline expansion or ref write may change what the leaves hold).
		const uexpr = use_expr_of(use_stmt);
		if (!uexpr || expr_has_call(uexpr)) {
			continue;
		}

		// Window: every intervening statement is a plain declare with a
		// call-free initializer that redeclares no name in play.
		let window_ok = true;
		const leaf_names = new Set(scan.leaves);
		if (leaf_names.has(name)) window_ok = false;
		const regs = leaf_regs(scan.leaves, status);
		for (let k = i + 1; window_ok && k < use_index; k++) {
			const w = out[k];
			if (w.kind !== "declare") {
				window_ok = false;
				break;
			}
			const winit = w.decl.init;
			if (!winit || expr_has_call(winit)) {
				window_ok = false;
				break;
			}
			if (w.decl.name === name || leaf_names.has(w.decl.name)) {
				window_ok = false;
				break;
			}
			// A window declare whose site register collides with a promoted
			// leaf's register would rewrite the leaf mid-window (the div_to
			// two-claim-systems receipt).
			const wreg = status.nir_site_allocs?.get(w.decl.key)?.reg;
			if (wreg && regs.has(wreg)) {
				window_ok = false;
				break;
			}
		}
		if (!window_ok) continue;

		// Composition guard: if this candidate's OWN init already received a
		// forwarded tree (an earlier candidate's use lived here), forwarding
		// would emit that inner tree at THIS candidate's use site — a span
		// the inner candidate's window never checked. Keep the slot store so
		// the inner tree stays at this declare's def position.
		if (composed_inits.has(name)) continue;

		// Rewrite: the use's leaf becomes the declaring initializer — on the
		// NIR spine (analysis truth, keeps this pass idempotent) and as an
		// AST use-site plan (the emission mechanism, applied per statement
		// build by apply_forward_use).
		const rewritten = expr_with(uexpr, use_path, stmt.decl.init as NirExpr);
		out[use_index] = stmt_with_use_expr(use_stmt, rewritten);
		if (use_stmt.kind === "declare") {
			composed_inits.add(use_stmt.decl.name);
		}
		record_use_site(use_stmt, use_path, (stmt.decl.init as NirExpr).node, use_sites);
		forward_defs.add(stmt.decl.node);
		// The declare now emits registration only.
		out[i] = { ...stmt, decl: { ...stmt.decl, init: null } };
	}

	// Recurse into nested lists of the REWRITTEN statements.
	for (let i = 0; i < out.length; i++) {
		const lists = nested_lists(out[i]);
		if (lists.length === 0) continue;
		const updated = lists.map((l) =>
			process_list(l, root, traffic, write_only, status, hidden_reads, use_sites, forward_defs),
		);
		let stmt = out[i];
		for (let n = 0; n < updated.length; n++) {
			stmt = with_nested_list(stmt, n, updated[n]);
		}
		out[i] = stmt;
	}
	return out;
}

/**
 * Cset-pair elision (stage 4): true when the fuse's flag name is provably
 * never read — the cmp/cset/store tail is dead and must be skipped. The
 * declare itself still builds (registration semantics preserved).
 */
export function cset_flag_is_write_only(ctx: NirEmitCtx, name: string): boolean {
	return ctx.write_only?.has(name) ?? false;
}
