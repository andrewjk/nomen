import { is_int_literal, parse_int_literal } from "../int_literal.ts";
import type { NirStmt } from "../nir/nir.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import { is_increment, scan_init } from "./neon_plan.ts";

/**
 * Full unrolling of fixed-trip loops (ASM_PLAN_2 tranche A, with tranche E's
 * index-constant reads and the outer-first composition addendum). When a
 * `while` has the canonical count-up shape with an INTEGER-LITERAL `<` bound
 * and a compile-time-constant induction init, the loop is exactly
 * `bound - init` iterations of the body — so the loop machinery (counter,
 * compare, branch) can be deleted and the body emitted once per trip.
 *
 * Soundness:
 * - `scan_init` requires the induction's nearest pre-loop def to establish
 *   a compile-time constant (literal, or — under composition — an
 *   expression over the enclosing copy's constants), and the update to be
 *   the sanctioned `+1` — the trip count is then exactly `bound - init`
 *   (not `ceil` of anything), so straight copies replace the loop with
 *   zero guards.
 * - The induction must not be ASSIGNED anywhere in the body (its per-copy
 *   value is the compile-time constant). READS are allowed and become
 *   immediate constants per copy (tranche E).
 * - No `break`/`continue` at THIS loop level (they target the deleted
 *   loop). `break`/`continue` inside NESTED loops target the nested loop
 *   and stay legal — and a nested loop that unrolls itself is gate-checked
 *   for exactly that. `return`/`exit`, `raw` (duplicate labels),
 *   `nested_func` (duplicate function labels), `anon_struct`, `opaque`,
 *   `async_block` reject. Non-scalar declarations reject: each copy
 *   re-declares into the same scope, which is only kept sound for scalars
 *   (fresh slot per copy, no destroy/cleanup interactions).
 * - Code size: composed emission ≤ 500 statements, trip count ≤ 64.
 *
 * Every rejected shape returns null and the loop emits exactly as before.
 */

// Default OFF (measured: unrolling alone is neutral-to-negative on serial
// FP dependence chains — mandelbrot n=1000 +8% before the spill fix,
// neutral after). Sound, tested, and available for shapes where copies are
// independent or compose (see plan_full_unroll).
let loop_unrolling_on = false;

export function loop_unrolling_enabled(): boolean {
	return loop_unrolling_on;
}

export function set_loop_unrolling_enabled(enabled: boolean): void {
	loop_unrolling_on = enabled;
}

const MAX_TRIP = 64;
const MAX_STMTS = 500;

/** A successful unroll plan: the induction's compile-time loop-entry value,
 *  the exact trip count (`bound - init`; 0 is legal — the loop never runs),
 *  and the total statement volume the unrolled emission produces (copies
 *  composed with nested unrolls, plus the post-loop induction store). */
export interface UnrollPlan {
	init: number;
	trip: number;
	emitted: number;
}

/**
 * Compile-time integer resolution over the init AST: integer literals, or an
 * expression over names the ambient unroll already holds constant (`+`/`-`
 * only). `var int j = i + 1` under an unrolled outer copy holding `i → k`
 * resolves to k+1 — the outer-first composition seam (ASM_PLAN_2 tranche E
 * addendum).
 */
function resolve_const_int(node: BaseNode | null, env: ReadonlyMap<string, number>): number | null {
	if (!node) return null;
	const n = node as unknown as Record<string, unknown>;
	if (n.node_type === "grouped") return resolve_const_int(n.value as BaseNode, env);
	if (n.node_type === "value") {
		const v = n.value as string;
		if (is_int_literal(v)) return parse_int_literal(v);
		const found = env.get(v);
		return found === undefined ? null : found;
	}
	if (n.node_type === "op") {
		const op = n.op as string;
		if (op !== "+" && op !== "-") return null;
		const left = resolve_const_int(n.left_value as BaseNode, env);
		if (left === null) return null;
		const right = resolve_const_int(n.right_value as BaseNode, env);
		if (right === null) return null;
		return op === "+" ? left + right : left - right;
	}
	return null;
}

/** Does any AST statement in the subtree ASSIGN `name` (assignment target)? */
function body_assigns_induction(s: NirStmt, induction: string): boolean {
	const node = s.node;
	if (!node) return false;
	const stack = [node];
	const seen = new Set<unknown>();
	while (stack.length) {
		const cur = stack.pop()!;
		if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
		seen.add(cur);
		const n = cur as unknown as Record<string, unknown>;
		if (n.node_type === "assign" || n.node_type === "assign_decl") {
			const left = n.left_value as { node_type?: string; value?: unknown } | undefined;
			if (left && left.node_type === "value" && left.value === induction) return true;
		}
		for (const key of Object.keys(n)) {
			if (key === "parent" || key === "scope") continue;
			const v = n[key];
			if (Array.isArray(v)) {
				for (const item of v) {
					if (item && typeof item === "object") stack.push(item);
				}
			} else if (v && typeof v === "object") {
				stack.push(v as unknown as BaseNode);
			}
		}
	}
	return false;
}

/** A nested `while` found in a candidate body, with its own context list and
 *  index (its init scan needs the containing list). */
interface NestedWhile {
	nstmt: NirStmt & { kind: "while" };
	index: number;
	list: readonly NirStmt[];
}

/** Collect the nested `while`s of a candidate body (through if/switch arms),
 *  each with its containing list and index. Returns "for" when a nested
 *  range/enumerable `for` is present — the planner is while-specific, so
 *  those still reject the parent's unroll. */
function collect_nested_whiles(stmts: readonly NirStmt[], out: NestedWhile[]): "ok" | "for" {
	for (let i = 0; i < stmts.length; i++) {
		const s = stmts[i];
		if (s.kind === "while") {
			out.push({ nstmt: s, index: i, list: stmts });
		} else if (s.kind === "for") {
			return "for";
		} else if (s.kind === "if") {
			if (collect_nested_whiles(s.then_branch, out) === "for") return "for";
			if (collect_nested_whiles(s.else_branch, out) === "for") return "for";
		} else if (s.kind === "switch_match") {
			for (const arm of s.arms) {
				if (collect_nested_whiles(arm.branch, out) === "for") return "for";
			}
			if (s.otherwise && collect_nested_whiles(s.otherwise, out) === "for") return "for";
		}
	}
	return "ok";
}

/** Statements that make a body un-unrollable when they appear at THIS
 *  loop's level; nested-loop bodies get their own context. */
function stmt_unrollable(s: NirStmt, nested: boolean): boolean {
	switch (s.kind) {
		case "declare": {
			if (s.decl.swap) return false;
			const mods = s.decl.modifiers;
			if (mods.is_array || mods.is_view || mods.is_ref || mods.is_nullable) return false;
			// Scalars only: per-copy re-declaration must not interact with
			// destroy/cleanup machinery.
			const name = s.decl.type?.name ?? "";
			return (
				name === "float" ||
				name === "int" ||
				name === "bool" ||
				name === "char" ||
				name === "int64" ||
				name === "uint64" ||
				name === "uint32" ||
				name === "int32" ||
				name === "uint"
			);
		}
		case "assign":
		case "eval":
		case "spawn":
			return true;
		case "if":
			return (
				s.then_branch.every((x) => stmt_unrollable(x, nested)) &&
				s.else_branch.every((x) => stmt_unrollable(x, nested))
			);
		case "while":
			// The nested loop consumes break/continue — recurse in nested
			// context; its update runs at our level.
			return (
				s.body.every((x) => stmt_unrollable(x, true)) &&
				(s.update === null || stmt_unrollable(s.update, nested))
			);
		case "for":
			return (
				s.body.every((x) => stmt_unrollable(x, true)) &&
				(s.update === null || stmt_unrollable(s.update, nested))
			);
		case "switch_match":
			return (
				s.arms.every((arm) => arm.branch.every((x) => stmt_unrollable(x, nested))) &&
				(s.otherwise === null || s.otherwise.every((x) => stmt_unrollable(x, nested)))
			);
		case "break":
		case "continue":
			return nested; // ours → reject; a nested loop's → fine
		case "return":
		case "exit":
			// A copy that returns is exactly an iteration that returns —
			// later copies are just unreachable bytes.
			return true;
		case "raw":
		case "nested_func":
		case "anon_struct":
		case "opaque":
		case "async_block":
			return false;
		default:
			return false;
	}
}

/**
 * Return the unroll plan when `nstmt` fully unrolls, else null. Requires the
 * NIR stmt (and its context list for the init scan) — NIR-cursor-gated like
 * the vectorizer, so the AST/byte-identity path never sees it.
 *
 * `const_env` is the AMBIENT induction-constant map (the enclosing unrolled
 * copy's map, when composition is in progress): names in it resolve to
 * compile-time integers, which is how a nested loop's `j = i + 1` init
 * becomes constant per outer copy. The top-level call passes undefined —
 * only literals resolve there (a literal non-zero init like `var i = 2`
 * unrolls too: the trip count is still exact).
 *
 * Outer-first composition (tranche E addendum): a body that nests `while`
 * loops no longer rejects outright. Each nested loop must itself plan under
 * EVERY copy's hypothetical env (`induction → init + k`); when it does, the
 * outer unroll seeds `induction_const` per copy and the nested loop unrolls
 * inside each copy with its own constant init (nbody's `j = i + 1` shape).
 * When any nested loop fails to plan for any copy, the parent rejects and
 * both stay loops (the pre-composition behavior).
 */
export function plan_full_unroll(
	nstmt: NirStmt & { kind: "while" },
	index: number,
	list: readonly NirStmt[],
	const_env?: ReadonlyMap<string, number>,
): UnrollPlan | null {
	if (!loop_unrolling_enabled()) return null;
	const cond = nstmt.cond;
	if (cond.kind !== "binary") return null;
	// The trip-count arithmetic below is `bound - init` — `<` only. (The op
	// lives on the AST OperationNode; NIR binary exprs carry no op.)
	if ((cond.node as { op?: unknown } | null)?.op !== "<") return null;
	if (cond.left.kind !== "leaf" || !cond.left.name) return null;
	const induction = cond.left.name;
	const bound = cond.right;
	if (bound.kind !== "leaf" || bound.name !== null) return null;
	const bound_text =
		bound.node && typeof (bound.node as any).value === "string"
			? ((bound.node as any).value as string)
			: null;
	if (bound_text === null || !/^\d+$/.test(bound_text)) return null;
	const bound_val = Number(bound_text);

	// The increment: update slot, or last body statement.
	let body = nstmt.body;
	if (nstmt.update) {
		if (!is_increment(nstmt.update, induction)) return null;
	} else {
		if (body.length === 0) return null;
		if (!is_increment(body[body.length - 1], induction)) return null;
		body = body.slice(0, -1);
	}
	if (body.length === 0) return null;

	// Init: the induction's nearest pre-loop def must establish a
	// compile-time constant — a literal, or an expression over the ambient
	// constants (the enclosing copy's induction). The trip count is then
	// exactly `bound - init` (0 allowed: the loop never runs, and a
	// composed inner's last outer copy needs exactly that).
	const init_scan = scan_init(list, index, induction);
	if (!init_scan.ok || !init_scan.init_node) return null;
	const init = resolve_const_int(init_scan.init_node, const_env ?? new Map());
	if (init === null || init < 0 || !Number.isSafeInteger(init)) return null;
	const trip = bound_val - init;
	if (trip < 0 || trip > MAX_TRIP) return null;

	// The body must not ASSIGN the induction (its per-copy value is the
	// compile-time constant; an assignment would break the substitution).
	// READS of the induction are allowed and become immediate constants per
	// copy. The read check is AST-side (see ast_references) — NIR facts are
	// blind to interpolation.
	const all_stmts = nstmt.update ? body : [...body, nstmt.update!];
	const full_stmts = all_stmts.filter(Boolean);
	for (const s of full_stmts) {
		if (body_assigns_induction(s, induction)) return null;
	}
	if (!body.every((s) => stmt_unrollable(s, false))) return null;

	// Nested loops: compose (see doc comment) or reject. Every nested while
	// must plan under every copy's hypothetical env. The size cap counts the
	// COMPOSED emission — the nested unrolls' volume is exactly what the
	// parent unroll multiplies.
	const nested: NestedWhile[] = [];
	if (collect_nested_whiles(full_stmts, nested) === "for") return null;
	let emitted: number;
	if (nested.length === 0) {
		emitted = count_stmts(body) * trip + 1;
	} else {
		let nested_emitted = 0;
		for (const nw of nested) {
			for (let k = 0; k < trip; k++) {
				const hyp = new Map(const_env ?? []);
				hyp.set(induction, init + k);
				const sub = plan_full_unroll(nw.nstmt, nw.index, nw.list, hyp);
				if (!sub) return null;
				nested_emitted += sub.emitted;
			}
		}
		emitted = (count_stmts(body) - nested.length) * trip + nested_emitted + 1;
	}
	if (emitted > MAX_STMTS) return null;

	return { init, trip, emitted };
}

/** Total NIR statements a straight-line emission of `stmts` produces
 *  (if/switch arms expanded; nested loops counted as their single kept
 *  statement — the composed case adds their volume separately). */
function count_stmts(stmts: readonly NirStmt[]): number {
	let n = 0;
	for (const s of stmts) {
		n++;
		if (s.kind === "if") {
			n += count_stmts(s.then_branch) + count_stmts(s.else_branch);
		} else if (s.kind === "while" || s.kind === "for") {
			n += count_stmts(s.body);
		} else if (s.kind === "switch_match") {
			for (const arm of s.arms) n += count_stmts(arm.branch);
			if (s.otherwise) n += count_stmts(s.otherwise);
		}
	}
	return n;
}
