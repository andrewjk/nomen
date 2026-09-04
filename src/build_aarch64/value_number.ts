import type BuildStatus from "../build_c/BuildStatus.ts";
import { is_float_type, is_scalar_type } from "../built_in_types.ts";
import { is_int_literal, parse_int_literal_bigint } from "../int_literal.ts";
import type { NirExpr, NirStmt } from "../nir/nir.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { hoistable_hoisted_param } from "./access_staging.ts";
import type { ForwardSplice, ForwardUse, PathStep } from "./forward.ts";

/**
 * Loop value numbering (ASM_PLAN_3 tranche M) — the pass the K and L
 * surveys scoped: "cross-block or cross-iteration reuse (clang keeps ~10
 * scalars through the whole loop body) needs the fuller value-numbering /
 * register-coalescing pass, one order larger than the staging tranche".
 *
 * The L tranche collapsed the per-statement `x0` staging inside verified
 * straight-line windows, but its pins die at every label and every loop
 * back-edge: the invariant SUMMANDS of the Knuth-D index chains
 * (`wd_off + u_len + 1` inside `scratch.get_at(..., wd_off + u_len + 1 + si2)`)
 * are re-derived — slot loads and all — on every iteration, because the
 * value they feed changes and nothing register-resident can carry the
 * invariant prefix across the boundary.
 *
 * This pass rewrites the loop at the NIR level, BEFORE the register plan:
 *
 * For every `while` loop, each pure `+` chain appearing in a hosted value
 * position (declare init, assign rhs, eval expr, return value — the same
 * positions the stage-4 forward-splice mechanism hosts, accessor args
 * included) is split into an INVARIANT part (name leaves never written
 * anywhere in the loop, plus literals) and a VARIANT part (the
 * induction-dependent leaves). The invariant sub-sum is hoisted into a
 * fresh `const _vn_N` declared immediately before the loop — a real
 * statement in BOTH the NIR spine and the AST list (the cursor's
 * index-alignment contract), so the register allocator sees its traffic
 * and may promote it (the loop-invariant-hot route), loop promotion may
 * claim it, and its slot is allocated by the ordinary declare builder.
 * Each occurrence's chain is rewritten to read the temp plus its variant
 * leaves. The temp is loop-invariant BY CONSTRUCTION: computed once
 * before the loop, register- or slot-resident across every iteration —
 * the cross-iteration reuse the staging pins could never express.
 *
 * Soundness:
 *
 * - Wrapping regrouping: every NAME leaf of a chain must share one
 *   non-float scalar type (the overwhelmingly common shape: all uint64).
 *   Integer adds are associative under two's-complement wrapping at a
 *   fixed width, so extracting the invariant sub-sum is value-exact for
 *   signed and unsigned alike. Floats are excluded wholesale
 *   (non-associative); `_param_N` temps are excluded (their slots are
 *   written by hoisted allocations INSIDE the loop — a hoisted read would
 *   see the previous iteration's value); `self` is excluded.
 * - Invariance: a name is invariant only when NOTHING in the loop writes
 *   it — every assign target (plain and path roots), every declare, for
 *   item, ref-argument of any call, and every swap-marshalled name in the
 *   whole body + update subtree, nested constructs included. Ref-arg and
 *   swap writes are collected from the NIR call facts, so the
 *   inline-ref-arg-call shapes the staging fences document cannot alias.
 * - The hoisted declares are real statements: built by the ordinary
 *   declare builder (slot allocation, promotion, scope registration), and
 *   removed from the shared AST again after the body build — the AST is
 *   shared with the C backend and re-lowered per inline expansion, and
 *   every build re-runs this pass deterministically and restores.
 * - Occurrences are rewritten through the SAME one-statement splice
 *   mechanism the stage-4 forwarder uses (apply → build → restore keyed
 *   by the host statement), extended with `arg<N>` descent steps so
 *   accessor arguments are reachable. Conditions and updates are NOT
 *   touched (no splice application runs there), and nested loops are left
 *   to their own pass invocation.
 * - The stage-4 forwarder declines single-use candidates whose use lives
 *   in a host statement (overlapping splices on one host would walk stale
 *   paths); every other consumer — allocator, traffic, cset/carry fuses,
 *   staging pins, unroll/vector planners — sees a plain tree through the
 *   standard channels.
 *
 * Kill-switch: `set_value_numbering_enabled` (default ON; OFF returns the
 * untouched spine — byte-identical output). Cursor-dependent like the
 * fuses: the byte-identity harness holds it OFF in both arms.
 */

let value_numbering_on = true;

/** Kill-switch for A/B byte-identity tests (default: ON). */
export function value_numbering_enabled(): boolean {
	return value_numbering_on;
}

export function set_value_numbering_enabled(enabled: boolean): void {
	value_numbering_on = enabled;
}

/** Terms per chain (mirrors the staging pass's chain bound). */
const MAX_CHAIN_TERMS = 6;
/** Hoisted temps per loop / per function. */
const MAX_TEMPS_PER_LOOP = 4;
const MAX_TEMPS_PER_FUNCTION = 12;
/** Occurrence-walk budget per loop body. */
const MAX_OCCURRENCES = 96;

export interface VnPlan {
	/** The rewritten spine (fresh lists where anything changed). */
	stmts: readonly NirStmt[];
	/** AST splices keyed by host statement node (merged into the ctx). */
	use_sites: ReadonlyMap<BaseNode, ForwardUse>;
	/** Host statement nodes carrying a splice — the forwarder's gate. */
	host_stmts: ReadonlySet<BaseNode>;
	/** Every `_vn_N` name this pass introduced. */
	temp_names: ReadonlySet<string>;
	/** Restores the shared AST lists (removes the synthetic declares). */
	undo: () => void;
}

interface ChainTerm {
	/** Identifier name, or null for an int literal. */
	name: string | null;
	/** Decimal literal value, or null for an identifier. */
	imm: string | null;
	/** The NIR leaf expr. */
	expr: NirExpr;
	/** The AST leaf node (ValueNode). */
	node: BaseNode;
}

interface Occurrence {
	/** The host statement node carrying the value position. */
	host: BaseNode;
	/** Descent path from the host statement's value root to the chain root. */
	path: PathStep[];
	/** The host statement's owning field (null for eval positions). */
	field: "value" | "right_value" | null;
	root: NirExpr;
	terms: ChainTerm[];
}

/**
 * A chain hiding in a checker-hoisted `_param_N` allocation (the D4
 * census shape: `scratch.get_at(scratchp, wd_off + u_len + 1 + si2)`
 * materializes its index as a hoisted temp, so the chain never appears in
 * a NIR value position). The rewrite has two halves: the temp's slot must
 * never be written (vn_param_inits — emit_allocations skips it and the
 * accessor's staging path re-builds the rewritten tree at the read), and
 * the NIR argument leaf is replaced so the plan sees the temp's traffic.
 */
interface AllocOccurrence {
	stmt: NirStmt;
	param_name: string;
	terms: ChainTerm[];
}

/** One chain occurrence in either channel, unified for grouping: its terms
 *  plus how to apply a replacement to its two spines (NIR always; the AST
 *  side differs between the splice and allocation mechanisms). */
interface ChainEntry {
	terms: ChainTerm[];
	start: number;
	apply: (replacement: { ast: BaseNode; nir: NirExpr }) => void;
}

interface TempGroup {
	inv_terms: ChainTerm[];
	type: Type;
	type_name: string;
	occurrences: ChainEntry[];
}

interface VnWalk {
	mutate: boolean;
	use_sites: Map<BaseNode, ForwardUse>;
	host_stmts: Set<BaseNode>;
	temp_names: Set<string>;
	temps_used: number;
	vn_param_inits: Map<BaseNode, Map<string, BaseNode>>;
	undo_records: { arr: BaseNode[]; nodes: BaseNode[] }[];
}

function unwrap_grouped(e: NirExpr): NirExpr {
	let cur = e;
	while (cur.kind === "wrap" && cur.node.node_type === "grouped" && cur.inner) cur = cur.inner;
	return cur;
}

type BinaryExpr = Extract<NirExpr, { kind: "binary" }>;

function is_chain_plus(e: NirExpr): e is BinaryExpr {
	return e.kind === "binary" && e.node.node_type === "op" && (e.node as OperationNode).op === "+";
}

/** Flatten a pure `+` chain over identifier/int-literal leaves (grouped
 *  wrappers transparent, casts a barrier). Null when the tree is not a
 *  chain, too small, or too large. */
function flatten_chain(e0: NirExpr): ChainTerm[] | null {
	const terms: ChainTerm[] = [];
	const walk = (e: NirExpr): boolean => {
		if (is_chain_plus(e)) {
			return walk(e.left) && walk(e.right);
		}
		const u = unwrap_grouped(e);
		if (u !== e) return walk(u);
		if (u.kind !== "leaf") return false;
		if (u.name !== null) {
			if (u.name === "self" || u.name.startsWith("_param_") || u.name.startsWith("_vn_")) {
				return false;
			}
			terms.push({ name: u.name, imm: null, expr: u, node: u.node });
			return true;
		}
		const raw = (u.node as ValueNode).value;
		if (typeof raw !== "string" || !is_int_literal(raw)) return false;
		const parsed = parse_int_literal_bigint(raw);
		if (parsed === null) return false;
		terms.push({ name: null, imm: parsed.toString(), expr: u, node: u.node });
		return true;
	};
	if (!walk(e0)) return null;
	if (terms.length < 2 || terms.length > MAX_CHAIN_TERMS) return null;
	return terms;
}

/** Descend an expression collecting chain occurrences at value positions.
 *  Eval positions (field null) cannot host a whole-root replacement, so an
 *  occurrence whose path is empty there is skipped. */
function collect_expr_occurrences(
	e: NirExpr | null,
	path: PathStep[],
	host: BaseNode,
	field: "value" | "right_value" | null,
	into: Occurrence[],
	budget: { left: number },
): void {
	if (!e || budget.left <= 0) return;
	budget.left--;
	const terms = flatten_chain(e);
	if (terms) {
		if (field !== null || path.length > 0) {
			into.push({ host, path, field, root: e, terms });
		}
		return;
	}
	if (is_chain_plus(e)) {
		collect_expr_occurrences(e.left, [...path, "left"], host, field, into, budget);
		collect_expr_occurrences(e.right, [...path, "right"], host, field, into, budget);
		return;
	}
	if (e.kind === "wrap") {
		if (e.node.node_type === "grouped" && e.inner) {
			collect_expr_occurrences(e.inner, [...path, "inner"], host, field, into, budget);
		}
		return;
	}
	if (e.kind === "call") {
		e.facts.args.forEach((arg, i) => {
			collect_expr_occurrences(arg, [...path, `arg${i}` as PathStep], host, field, into, budget);
		});
		return;
	}
	if (e.kind === "method_call") {
		e.facts.args.forEach((arg, i) => {
			collect_expr_occurrences(arg, [...path, `arg${i}` as PathStep], host, field, into, budget);
		});
		return;
	}
}

/** Flatten a pure `+` chain over an AST tree (the checker-hoisted
 *  `_param_N` inits — allocations never lower to NIR, so their chains are
 *  analyzed on the AST and the spine terms are synthesized). */
function flatten_chain_ast(node0: BaseNode): ChainTerm[] | null {
	const terms: ChainTerm[] = [];
	const leaf = (n0: BaseNode): boolean => {
		let n = n0;
		while (n.node_type === "grouped") {
			n = (n as unknown as { value?: BaseNode }).value as BaseNode;
		}
		if (n.node_type !== "value") return false;
		const raw = (n as ValueNode).value;
		if (typeof raw !== "string") return false;
		if (is_int_literal(raw)) {
			const parsed = parse_int_literal_bigint(raw);
			if (parsed === null) return false;
			terms.push({
				name: null,
				imm: parsed.toString(),
				expr: { kind: "leaf", node: n, name: null },
				node: n,
			});
			return true;
		}
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return false;
		if (raw === "true" || raw === "false" || raw === "self") return false;
		if (raw.startsWith("_param_") || raw.startsWith("_vn_")) return false;
		terms.push({ name: raw, imm: null, expr: { kind: "leaf", node: n, name: raw }, node: n });
		return true;
	};
	const walk = (n: BaseNode): boolean => {
		if (n.node_type === "op") {
			const op = n as OperationNode;
			if (op.op !== "+" || !op.left_value || !op.right_value) return false;
			return walk(op.left_value) && walk(op.right_value);
		}
		return leaf(n);
	};
	if (!walk(node0)) return null;
	if (terms.length < 2 || terms.length > MAX_CHAIN_TERMS) return null;
	return terms;
}

/** Checker-hoisted `_param_N` allocations on the loop body's statements,
 *  whose initializer is a chainable pure `+` tree (the same gates the
 *  staging forwarder applies — the rewrite rides its read-site mechanism). */
function collect_alloc_occurrences(list: readonly NirStmt[], into: AllocOccurrence[]): void {
	const walk = (stmts: readonly NirStmt[]): void => {
		for (const s of stmts) {
			const allocs = (s.node as { allocations?: BaseNode[] } | null | undefined)?.allocations;
			if (Array.isArray(allocs)) {
				for (const alloc of allocs) {
					const init = hoistable_hoisted_param(alloc, s.node);
					if (!init) continue;
					const terms = flatten_chain_ast(init);
					if (!terms) continue;
					const name = (alloc as DeclarationNode).name as string;
					into.push({ stmt: s, param_name: name, terms });
				}
			}
			switch (s.kind) {
				case "if":
					walk(s.then_branch);
					walk(s.else_branch);
					break;
				case "switch_match":
					for (const arm of s.arms) walk(arm.branch);
					if (s.otherwise) walk(s.otherwise);
					break;
				case "async_block":
					walk(s.body);
					break;
				default:
					break;
			}
		}
	};
	walk(list);
}

/** The NIR leaf expr naming `name` inside an expression tree (the argument
 *  position a hoisted temp occupies). */
function find_leaf_expr(e: NirExpr | null, name: string): NirExpr | null {
	if (!e) return null;
	if (e.kind === "leaf") return e.name === name ? e : null;
	if (e.kind === "binary") return find_leaf_expr(e.left, name) ?? find_leaf_expr(e.right, name);
	if (e.kind === "wrap") return e.inner ? find_leaf_expr(e.inner, name) : null;
	if (e.kind === "call") {
		for (const a of e.facts.args) {
			const f = find_leaf_expr(a, name);
			if (f) return f;
		}
		return null;
	}
	if (e.kind === "method_call") {
		for (const a of e.facts.args) {
			const f = find_leaf_expr(a, name);
			if (f) return f;
		}
		return null;
	}
	return null;
}

/** Hosted value positions of one statement: the expr plus the owning field
 *  (null for eval positions — see collect_expr_occurrences). */ function hosted_value_expr(
	s: NirStmt,
): { expr: NirExpr | null; field: "value" | "right_value" | null } | null {
	switch (s.kind) {
		case "declare":
			return { expr: s.decl.init, field: "value" };
		case "assign":
			return { expr: s.rhs, field: "right_value" };
		case "return":
			return { expr: s.value, field: "value" };
		case "eval":
			return { expr: s.expr, field: null };
		default:
			return null;
	}
}

function host_of(s: NirStmt): BaseNode {
	switch (s.kind) {
		case "declare":
			return s.decl.node;
		case "return":
			return s.node;
		case "eval":
			return s.expr.node;
		default:
			return s.node;
	}
}

/** Statements whose value positions may host a chain occurrence. Nested
 *  loops are skipped (each loop processes its own body); arm lists are
 *  walked (cross-block reuse is the point). */
function collect_stmt_occurrences(list: readonly NirStmt[], into: Occurrence[]): void {
	const budget = { left: MAX_OCCURRENCES };
	const walk = (stmts: readonly NirStmt[]): void => {
		for (const s of stmts) {
			if (budget.left <= 0) return;
			const hosted = hosted_value_expr(s);
			if (hosted?.expr) {
				collect_expr_occurrences(hosted.expr, [], host_of(s), hosted.field, into, budget);
			}
			switch (s.kind) {
				case "if":
					walk(s.then_branch);
					walk(s.else_branch);
					break;
				case "switch_match":
					for (const arm of s.arms) walk(arm.branch);
					if (s.otherwise) walk(s.otherwise);
					break;
				case "async_block":
					walk(s.body);
					break;
				// Nested while/for bodies process their own occurrences.
				default:
					break;
			}
		}
	};
	walk(list);
}

/** Every name the loop may write: assign targets (plain roots and path
 *  receivers), declares, for items, ref arguments, swap-marshalled names —
 *  over body + update, every nested construct, nested func bodies included
 *  (conservative). */
function collect_loop_writes(list: readonly NirStmt[], into: Set<string>): void {
	const leaf_name_of = (e: NirExpr | null): string | null => {
		if (!e) return null;
		const u = unwrap_grouped(e);
		return u.kind === "leaf" ? u.name : null;
	};
	const expr_writes = (e: NirExpr | null): void => {
		if (!e) return;
		switch (e.kind) {
			case "leaf":
				return;
			case "binary":
				expr_writes(e.left);
				expr_writes(e.right);
				return;
			case "wrap":
				if (e.inner) expr_writes(e.inner);
				return;
			case "path":
				expr_writes(e.receiver);
				return;
			case "call":
			case "method_call": {
				for (const idx of e.facts.ref_arg_indices) {
					const name = leaf_name_of(e.facts.args[idx] ?? null);
					if (name) into.add(name);
				}
				for (const sw of e.facts.swap_exprs) {
					const name = leaf_name_of(sw);
					if (name) into.add(name);
				}
				for (const arg of e.facts.args) expr_writes(arg);
				return;
			}
			case "flow":
				if (e.scrutinee) expr_writes(e.scrutinee);
				for (const arm of e.arms) {
					if (arm.condition) expr_writes(arm.condition);
					collect_loop_writes(arm.branch, into);
				}
				if (e.otherwise) collect_loop_writes(e.otherwise, into);
				return;
			case "spawn":
				expr_writes(e.call);
				return;
			default:
				return;
		}
	};
	const target_leaf = (e: NirExpr): void => {
		const u = unwrap_grouped(e);
		if (u.kind === "leaf" && u.name) into.add(u.name);
		else if (u.kind === "path") {
			let r = u.receiver;
			while (r.kind === "wrap") r = r.inner ?? r;
			if (r.kind === "leaf" && r.name) into.add(r.name);
		}
	};
	const swap_leaf = (e: NirExpr | null): void => {
		const name = leaf_name_of(e);
		if (name) into.add(name);
	};
	const walk = (stmts: readonly NirStmt[]): void => {
		for (const s of stmts) {
			switch (s.kind) {
				case "declare":
					if (s.decl.name) into.add(s.decl.name);
					expr_writes(s.decl.init);
					swap_leaf(s.decl.swap);
					break;
				case "assign":
					target_leaf(s.target);
					expr_writes(s.rhs);
					swap_leaf(s.swap);
					break;
				case "eval":
					expr_writes(s.expr);
					break;
				case "return":
					expr_writes(s.value);
					break;
				case "if":
					expr_writes(s.cond);
					walk(s.then_branch);
					walk(s.else_branch);
					break;
				case "while":
					expr_writes(s.cond);
					walk(s.body);
					if (s.update) walk([s.update]);
					break;
				case "for":
					into.add(s.item_name);
					if (s.list) expr_writes(s.list);
					walk(s.body);
					if (s.update) walk([s.update]);
					break;
				case "switch_match":
					if (s.scrutinee) expr_writes(s.scrutinee);
					for (const arm of s.arms) {
						if (arm.condition) expr_writes(arm.condition);
						walk(arm.branch);
					}
					if (s.otherwise) walk(s.otherwise);
					break;
				case "spawn":
					expr_writes(s.call);
					break;
				case "async_block":
					walk(s.body);
					break;
				case "nested_func":
					walk(s.body);
					break;
				default:
					break;
			}
		}
	};
	walk(list);
}

/** The nested AST statement list at `index` for a paired parent AST node
 *  (if arms: then=0/else=1; switch/match: arms then otherwise; loops and
 *  async blocks: their single body). */
function ast_statements_of(ast: BaseNode | undefined, index: number): BaseNode[] | null {
	if (!ast) return null;
	switch (ast.node_type) {
		case "if": {
			const ifn = ast as unknown as {
				if_branch?: { statements?: BaseNode[] } | null;
				else_branch?: { statements?: BaseNode[] } | null;
			};
			const list = index === 0 ? ifn.if_branch?.statements : ifn.else_branch?.statements;
			return Array.isArray(list) ? list : null;
		}
		case "switch":
		case "match": {
			const sw = ast as unknown as {
				cases?: { branch?: { statements?: BaseNode[] } }[];
				else_branch?: { statements?: BaseNode[] } | null;
			};
			if (index < (sw.cases?.length ?? 0)) {
				const list = sw.cases![index]?.branch?.statements;
				return Array.isArray(list) ? list : null;
			}
			const list = sw.else_branch?.statements;
			return Array.isArray(list) ? list : null;
		}
		case "async_block":
		case "while":
		case "for": {
			const list = (ast as unknown as { statements?: BaseNode[] }).statements;
			return Array.isArray(list) ? list : null;
		}
		default:
			return null;
	}
}

function nested_lists(stmt: NirStmt): readonly (readonly NirStmt[])[] {
	switch (stmt.kind) {
		case "if":
			return [stmt.then_branch, stmt.else_branch];
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
		default:
			return stmt;
	}
}

/** Apply replacement roots to one expression tree (by node identity). */
function apply_replacements(e: NirExpr, reps: Map<NirExpr, NirExpr>): NirExpr {
	const rep = reps.get(e);
	if (rep) return rep;
	switch (e.kind) {
		case "binary": {
			const l = apply_replacements(e.left, reps);
			const r = apply_replacements(e.right, reps);
			return l === e.left && r === e.right ? e : { ...e, left: l, right: r };
		}
		case "wrap": {
			if (!e.inner) return e;
			const i = apply_replacements(e.inner, reps);
			return i === e.inner ? e : { ...e, inner: i };
		}
		case "call": {
			let changed = false;
			const args = e.facts.args.map((a) => {
				const n = apply_replacements(a, reps);
				changed ||= n !== a;
				return n;
			});
			return changed ? { ...e, facts: { ...e.facts, args } } : e;
		}
		case "method_call": {
			let changed = false;
			const args = e.facts.args.map((a) => {
				const n = apply_replacements(a, reps);
				changed ||= n !== a;
				return n;
			});
			return changed ? { ...e, facts: { ...e.facts, args } } : e;
		}
		default:
			return e;
	}
}

function stmt_with_value_expr(s: NirStmt, e: NirExpr | null): NirStmt {
	switch (s.kind) {
		case "declare":
			return { ...s, decl: { ...s.decl, init: e } };
		case "assign":
			return { ...s, rhs: (e ?? s.rhs) as NirExpr };
		case "return":
			return { ...s, value: e };
		case "eval":
			return { ...s, expr: (e ?? s.expr) as NirExpr };
		default:
			return s;
	}
}

function process_list(
	nir_list: readonly NirStmt[],
	ast_list: BaseNode[] | null,
	walk: VnWalk,
): readonly NirStmt[] {
	if (!ast_list || ast_list.length !== nir_list.length) return nir_list;
	const out: NirStmt[] = [];
	const ast_insertions: { index: number; nodes: BaseNode[] }[] = [];
	let changed = false;

	for (let i = 0; i < nir_list.length; i++) {
		const stmt = nir_list[i];
		const ast = ast_list[i];

		if (stmt.kind === "while" && ast && ast.node_type === "while") {
			const body_list = ast_statements_of(ast, 0);
			const rewritten_body = process_list(stmt.body, body_list, walk);
			let while_stmt: NirStmt & { kind: "while" } =
				rewritten_body === stmt.body
					? (stmt as NirStmt & { kind: "while" })
					: ({ ...stmt, body: rewritten_body } as NirStmt & { kind: "while" });

			const hoisted = hoist_loop_invariants(while_stmt, walk);
			if (hoisted) {
				out.push(...hoisted.declares);
				if (walk.mutate) ast_insertions.push({ index: i, nodes: hoisted.ast_declares });
				while_stmt = hoisted.while_stmt;
			}
			out.push(while_stmt);
			if (hoisted || while_stmt !== stmt) changed = true;
			continue;
		}

		const lists = nested_lists(stmt);
		if (lists.length > 0) {
			let updated = stmt;
			for (let n = 0; n < lists.length; n++) {
				const child_ast = ast_statements_of(ast, n);
				const rewritten = process_list(lists[n], child_ast, walk);
				if (rewritten !== lists[n]) {
					updated = with_nested_list(updated, n, rewritten);
					changed = true;
				}
			}
			out.push(updated);
			continue;
		}

		out.push(stmt);
	}

	// Apply the AST insertions highest-index-first so the recorded indices
	// stay valid, and remember them for the undo.
	ast_insertions.sort((a, b) => b.index - a.index);
	for (const ins of ast_insertions) {
		ast_list.splice(ins.index, 0, ...ins.nodes);
		walk.undo_records.push({ arr: ast_list, nodes: ins.nodes });
		changed = true;
	}

	return changed ? out : nir_list;
}

interface HoistedLoop {
	declares: NirStmt[];
	ast_declares: BaseNode[];
	while_stmt: NirStmt & { kind: "while" };
}

/** Build a left-associated `+` tree in lockstep over the AST and NIR spines.
 *  The LAST op node is the root. */
function build_sum(
	ast_leaves: BaseNode[],
	nir_leaves: NirExpr[],
	type: Type,
	start: number,
): { ast: BaseNode; nir: NirExpr } {
	let ast_acc: BaseNode = ast_leaves[0];
	let nir_acc: NirExpr = nir_leaves[0];
	for (let i = 1; i < ast_leaves.length; i++) {
		const op = new OperationNode(start, "+", ast_acc, ast_leaves[i], type);
		ast_acc = op;
		nir_acc = { kind: "binary", node: op, left: nir_acc, right: nir_leaves[i] };
	}
	return { ast: ast_acc, nir: nir_acc };
}

/** Split every chain occurrence in the loop into invariant + variant parts,
 *  introduce one temp per distinct invariant multiset, rewrite the
 *  occurrences to read the temps, and return the hoisted declares
 *  (NIR + AST) for insertion before the loop. Chains come from two
 *  collectors: NIR value positions and checker-hoisted `_param_N`
 *  allocation inits. */
function hoist_loop_invariants(
	while_stmt: NirStmt & { kind: "while" },
	walk: VnWalk,
): HoistedLoop | null {
	const writes = new Set<string>();
	collect_loop_writes(while_stmt.body, writes);
	if (while_stmt.update) collect_loop_writes([while_stmt.update], writes);

	// Unified chain entries: each knows its terms and how to apply a
	// replacement (AST side + NIR spine side).
	const entries: ChainEntry[] = [];

	const occurrences: Occurrence[] = [];
	collect_stmt_occurrences(while_stmt.body, occurrences);
	for (const occ of occurrences) {
		entries.push({
			terms: occ.terms,
			start: occ.root.node.start ?? 0,
			apply: (replacement) => {
				reps_map.set(occ.root, replacement.nir);
				record_splice(walk, occ, replacement.ast);
			},
		});
	}

	const alloc_occs: AllocOccurrence[] = [];
	collect_alloc_occurrences(while_stmt.body, alloc_occs);
	for (const occ of alloc_occs) {
		// The NIR argument leaf this temp occupies must exist (the spine
		// replacement is what gives the temp its planner-visible reads).
		const arg_leaf = find_leaf_expr(hosted_value_expr(occ.stmt)?.expr ?? null, occ.param_name);
		if (!arg_leaf) continue;
		entries.push({
			terms: occ.terms,
			start: occ.terms[0]?.node.start ?? 0,
			apply: (replacement) => {
				reps_map.set(arg_leaf, replacement.nir);
				if (!walk.mutate) return;
				let m = vn_param_map.get(occ.stmt.node);
				if (!m) {
					m = new Map();
					vn_param_map.set(occ.stmt.node, m);
				}
				m.set(occ.param_name, replacement.ast);
			},
		});
	}

	if (entries.length === 0) return null;
	if (walk.temps_used >= MAX_TEMPS_PER_FUNCTION) return null;

	const reps_map = new Map<NirExpr, NirExpr>();
	const vn_param_map = new Map<BaseNode, Map<string, BaseNode>>();
	let while_out: NirStmt & { kind: "while" } = while_stmt;

	// One temp per distinct invariant multiset, in first-touch order.
	const groups = new Map<string, TempGroup>();
	for (const occ of entries) {
		const inv: ChainTerm[] = [];
		let type_name: string | null = null;
		let type_obj: Type | null = null;
		let ok = true;
		for (const term of occ.terms) {
			if (term.name === null) {
				inv.push(term);
				continue;
			}
			const node_type = (term.node as ValueNode).type;
			const tn = node_type?.name ?? "";
			if (!tn || is_float_type(tn) || !is_scalar_type(tn)) {
				ok = false;
				break;
			}
			if (type_name === null) {
				type_name = tn;
				type_obj = node_type ?? null;
			} else if (type_name !== tn) {
				ok = false;
				break;
			}
			if (!writes.has(term.name)) inv.push(term);
		}
		if (!ok || type_name === null) continue;
		// The temp must compute something: at least one invariant NAME and
		// a second invariant term. A single-term invariant part is a bare
		// copy (v + b → copy of b): the temp's read costs what the leaf's
		// read cost, so the rewrite is pure overhead (and it would disturb
		// carry-fuse shapes for nothing).
		if (inv.length < 2) continue;
		if (!inv.some((t) => t.name !== null)) continue;
		const inv_names = inv
			.filter((t) => t.name)
			.map((t) => t.name!)
			.sort();
		const inv_imms = inv
			.filter((t) => t.imm !== null)
			.map((t) => t.imm!)
			.sort();
		const key = `inv:${inv_names.join("+")}|${inv_imms.join("+")}`;
		const group = groups.get(key);
		if (group) {
			group.occurrences.push(occ);
		} else {
			groups.set(key, {
				inv_terms: inv,
				type: type_obj ?? new Type(type_name),
				type_name,
				occurrences: [occ],
			});
		}
	}
	if (groups.size === 0) return null;
	if (groups.size > MAX_TEMPS_PER_LOOP) return null;
	if (walk.temps_used + groups.size > MAX_TEMPS_PER_FUNCTION) return null;

	if (process.env.NOMEN_VN_DBG) {
		const parts: string[] = [];
		for (const [k, g] of groups) {
			parts.push(`\n  ${k} x${g.occurrences.length}`);
		}
		console.error(`[vn] loop@${while_stmt.node.start}: temps=${groups.size}${parts.join("")}`);
	}

	// One hoisted declare per group: the invariant sub-sum, computed before
	// the loop — a real statement in both spines.
	const declares: NirStmt[] = [];
	const ast_declares: BaseNode[] = [];
	const temp_for_key = new Map<string, string>();
	for (const [key, group] of groups) {
		walk.temps_used += 1;
		const temp_name = `_vn_${walk.temps_used}`;
		temp_for_key.set(key, temp_name);
		walk.temp_names.add(temp_name);

		const start = group.occurrences[0]?.start ?? 0;
		const sum = build_sum(
			group.inv_terms.map((t) => t.node),
			group.inv_terms.map((t) => t.expr),
			group.type,
			start,
		);
		const ast_decl = new DeclarationNode(start, "private", "const", temp_name, group.type, sum.ast);
		declares.push({
			kind: "declare",
			node: ast_decl,
			decl: {
				name: temp_name,
				key: `${temp_name}@vn`,
				type: group.type,
				modifiers: {},
				init: sum.nir,
				swap: null,
				node: ast_decl,
			},
		});
		ast_declares.push(ast_decl);
	}

	// Rewrite the occurrences: AST-side rewrites (build time) + spine
	// replacement (now), both from the same synthetic trees.
	for (const [key, group] of groups) {
		const temp_name = temp_for_key.get(key)!;
		for (const entry of group.occurrences) {
			const temp_leaf = new ValueNode(entry.start, temp_name, group.type);
			// Replacement chain: temp + (this occurrence's) variant leaves,
			// in flatten order. Pure-LICM occurrences (no variant terms)
			// become the bare temp leaf.
			const variant = entry.terms.filter((t) => t.name !== null && writes.has(t.name));
			const built = build_sum(
				[temp_leaf, ...variant.map((t) => t.node)],
				[{ kind: "leaf", node: temp_leaf, name: temp_name }, ...variant.map((t) => t.expr)],
				group.type,
				entry.start,
			);
			entry.apply(built);
		}
	}

	if (reps_map.size > 0) {
		// Rebuild the loop body with the spine replacements applied.
		const new_body = rewrite_spine_list(while_stmt.body, reps_map);
		while_out = { ...while_stmt, body: new_body as NirStmt[] };
	} else {
		while_out = while_stmt;
	}
	walk.vn_param_inits = vn_param_map;
	return { declares, ast_declares, while_stmt: while_out };
}

/** Rebuild a statement list, applying replacement roots to the hosted
 *  value positions of every statement. */
function rewrite_spine_list(
	list: readonly NirStmt[],
	reps: Map<NirExpr, NirExpr>,
): readonly NirStmt[] {
	let changed = false;
	const out = list.map((s) => {
		const hosted = hosted_value_expr(s);
		if (!hosted?.expr) return s;
		const rewritten = apply_replacements(hosted.expr, reps);
		if (rewritten === hosted.expr) return s;
		changed = true;
		return stmt_with_value_expr(s, rewritten);
	});
	return changed ? out : list;
}

function record_splice(walk: VnWalk, occ: Occurrence, replacement: BaseNode): void {
	if (!walk.mutate) return;
	walk.host_stmts.add(occ.host);
	const splice: ForwardSplice = { path: occ.path, init: replacement };
	const existing = walk.use_sites.get(occ.host);
	if (existing) existing.splices.push(splice);
	else walk.use_sites.set(occ.host, { host: occ.host, field: occ.field, splices: [splice] });
}

/**
 * Run the pass over one function-like body. `mutate_ast` splices the
 * synthetic hoisted declares into the shared AST lists and records the
 * build-time use sites — true for emission builds; the planning-only
 * caller passes false (the spine rewrite still runs, so the plan sees the
 * same traffic the emission will produce).
 */
export function value_number_loops(
	body: readonly NirStmt[],
	ast_list: BaseNode[],
	status: BuildStatus,
	mutate_ast: boolean,
): VnPlan {
	if (!value_numbering_on) {
		return {
			stmts: body,
			use_sites: new Map(),
			host_stmts: new Set(),
			temp_names: new Set(),
			undo: () => {},
		};
	}
	const walk: VnWalk = {
		mutate: mutate_ast,
		use_sites: new Map(),
		host_stmts: new Set(),
		temp_names: new Set(),
		temps_used: 0,
		vn_param_inits: new Map(),
		undo_records: [],
	};
	const stmts = process_list(body, ast_list, walk);
	const old_vn_param_map = status.vn_param_inits;
	status.vn_param_inits = walk.vn_param_inits;
	const undo = (): void => {
		status.vn_param_inits = old_vn_param_map;
		for (const rec of walk.undo_records.reverse()) {
			const idx = rec.arr.indexOf(rec.nodes[0]);
			if (idx !== -1) rec.arr.splice(idx, rec.nodes.length);
		}
	};
	return {
		stmts,
		use_sites: walk.use_sites,
		host_stmts: walk.host_stmts,
		temp_names: walk.temp_names,
		undo,
	};
}
