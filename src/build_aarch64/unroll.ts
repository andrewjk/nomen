import type { NirStmt } from "../nir/nir.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import { is_increment, scan_init } from "./neon_plan.ts";

/**
 * Full unrolling of fixed-trip loops (ASM_PLAN_2 tranche A). When a `while`
 * has the canonical count-up shape with an INTEGER-LITERAL bound and an
 * induction variable the body never reads, the loop is exactly B iterations
 * of the body — so the loop machinery (counter, compare, branch) can be
 * deleted and the body emitted B times.
 *
 * Soundness:
 * - `scan_init` requires the induction's nearest pre-loop def to establish
 *   literal 0, and the update to be the sanctioned `+1` — the trip count is
 *   then exactly B (not `ceil` of anything), so B straight copies replace
 *   the loop with zero guards.
 * - The induction must not be READ anywhere in the body (stmt_reads over
 *   the NIR body) — dropping the counter is then unobservable.
 * - No `break`/`continue` at THIS loop level (they target the deleted
 *   loop). `break`/`continue` inside NESTED loops target the nested loop
 *   and stay legal. `return`/`exit`, `raw` (duplicate labels),
 *   `nested_func` (duplicate function labels), `anon_struct`, `opaque`,
 *   `async_block` reject. Non-scalar declarations reject: each copy
 *   re-declares into the same scope, which is only kept sound for scalars
 *   (fresh slot per copy, no destroy/cleanup interactions).
 * - Code size: body statements × trip count ≤ 500, trip count ≤ 64.
 *
 * Every rejected shape returns null and the loop emits exactly as before.
 */

// Default OFF until tranche B (caller-saved FP promotion) lands: unrolling
// alone multiplies stack-slot traffic per copy without shortening it
// (measured: mandelbrot n=1000 +8%). Enabled by tranche B's commit.
let loop_unrolling_on = false;

export function loop_unrolling_enabled(): boolean {
	return loop_unrolling_on;
}

export function set_loop_unrolling_enabled(enabled: boolean): void {
	loop_unrolling_on = enabled;
}

const MAX_TRIP = 64;
const MAX_STMTS = 500;

/**
 * Does any node in this AST subtree read identifier `name`? Walks ALL
 * object properties (nodes, arrays) — deliberately over-approximate, and
 * deliberately AST-side: the NIR read facts are blind to interpolated-
 * string arguments (`"\{x}"` lowers to a format-string leaf whose reads
 * ride in node fields the NIR never sees), and for the unroller a false
 * "read" merely keeps the loop. Used for the induction-read check.
 */
function ast_references(node: unknown, name: string, seen: Set<unknown>): boolean {
	if (!node || typeof node !== "object") return false;
	if (seen.has(node)) return false;
	seen.add(node);
	const n = node as Record<string, unknown>;
	if (n.node_type === "value" && n.value === name) return true;
	for (const key of Object.keys(n)) {
		if (key === "parent" || key === "scope") continue;
		const v = n[key];
		if (Array.isArray(v)) {
			for (const item of v) {
				if (ast_references(item, name, seen)) return true;
			}
		} else if (v && typeof v === "object" && "node_type" in (v as object)) {
			if (ast_references(v, name, seen)) return true;
		}
	}
	return false;
}

/** Any body/update AST statement reads the induction? */
function body_reads_induction(stmts: readonly NirStmt[], induction: string): boolean {
	for (const s of stmts) {
		if (s.node && ast_references(s.node, induction, new Set())) return true;
	}
	return false;
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
 * Return the trip count when `nstmt` fully unrolls, else null. Requires the
 * NIR stmt (and its context list for the init scan) — NIR-cursor-gated like
 * the vectorizer, so the AST/byte-identity path never sees it.
 */
export function plan_full_unroll(
	nstmt: NirStmt & { kind: "while" },
	index: number,
	list: readonly NirStmt[],
): number | null {
	if (!loop_unrolling_enabled()) return null;
	const cond = nstmt.cond;
	if (cond.kind !== "binary") return null;
	if (cond.left.kind !== "leaf" || !cond.left.name) return null;
	const induction = cond.left.name;
	const bound = cond.right;
	if (bound.kind !== "leaf" || bound.name !== null) return null;
	const bound_text =
		bound.node && typeof (bound.node as any).value === "string"
			? ((bound.node as any).value as string)
			: null;
	if (bound_text === null || !/^\d+$/.test(bound_text)) return null;
	const trip = Number(bound_text);
	if (trip < 1 || trip > MAX_TRIP) return null;

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

	// Init: the induction's nearest pre-loop def must establish literal 0,
	// so the trip count is exactly `trip`.
	const init = scan_init(list, index, induction);
	if (!init.ok || !init.init_node) return null;
	const init_value = (init.init_node as { value?: unknown }).value;
	if (typeof init_value !== "string" || !/^\+?0$/.test(init_value)) return null;

	// The body must not read the induction (dropping the counter is then
	// unobservable) and must be structurally unrollable. The read check is
	// AST-side (see ast_references) — NIR facts are blind to interpolation.
	const all_stmts = nstmt.update ? body : [...body, nstmt.update!];
	if (body_reads_induction(all_stmts.filter(Boolean), induction)) return null;
	if (!body.every((s) => stmt_unrollable(s, false))) return null;

	// Code size bound.
	let stmt_count = 0;
	const count = (stmts: readonly NirStmt[]): void => {
		for (const s of stmts) {
			stmt_count++;
			if (s.kind === "if") {
				count(s.then_branch);
				count(s.else_branch);
			} else if (s.kind === "while" || s.kind === "for") {
				count(s.body);
			} else if (s.kind === "switch_match") {
				for (const arm of s.arms) count(arm.branch);
				if (s.otherwise) count(s.otherwise);
			}
		}
	};
	count(body);
	if (stmt_count * trip > MAX_STMTS) return null;

	return trip;
}
