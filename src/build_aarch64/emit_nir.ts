import type BuildStatus from "../build_c/BuildStatus.ts";
import { lower_function } from "../nir/from_ast.ts";
import type { NirExpr, NirStmt } from "../nir/nir.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import MatchNode from "../nodes/MatchNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_assignment_node from "./build_assignment_node.ts";
import build_async_block_node from "./build_async_block_node.ts";
import build_block_node from "./build_block_node.ts";
import build_declaration_node from "./build_declaration_node.ts";
import build_for_loop_node from "./build_for_loop_node.ts";
import build_if_else_node from "./build_if_else_node.ts";
import build_match_node from "./build_match_node.ts";
import build_node from "./build_node.ts";
import build_return_node from "./build_return_node.ts";
import build_switch_node from "./build_switch_node.ts";
import build_while_loop_node from "./build_while_loop_node.ts";
import { neon_vectorization_enabled } from "./neon_emit.ts";
import { plan_vector_for, plan_vector_loop } from "./neon_plan.ts";
import { plan_full_unroll } from "./unroll.ts";

/**
 * NIR-driven emission (ASM_PLAN phase 4, canonical-IR stage 2).
 *
 * build_function_node lowers the body to NIR ONCE (shared with the promotion
 * planner) and — lowering being TOTAL over the checked AST — publishes the
 * ctx for EVERY function body; the whole-function AST fallback is retired
 * (a residual unknown kind is a tripwire throw). build_block_node's
 * statement loop then dispatches through `emit_stmt_from_nir`, which:
 *
 * - only consumes NIR entries when the ctx's `ast` IS the statement list
 *   being iterated (array identity). Any nested block build that doesn't own
 *   the list (synthetic statement fragments, top-level-scope emission…)
 *   sees a different array and falls back to the plain AST walk —
 *   misalignment is structurally impossible to corrupt emission with.
 * - handles `if`/`while`/`for`/`switch`/`match` NIR-natively: the builders
 *   take the lowered branch/body lists and hand them to their nested blocks
 *   (label numbering, scope frames, buffer-cache snapshots, loop promotion,
 *   writebacks and condition lowering stay in the builders, so both paths are
 *   the same code — no drift).
 * - handles `return` NIR-natively: the builder keeps every ownership/cleanup
 *   decision on the AST node, and its value expression is emitted through
 *   `emit_expr_from_nir` (the expression seam below).
 * - handles `declare`/`assign`/`eval` NIR-natively the same way: the builders
 *   keep every semantic decision on the AST node, and the value positions
 *   (declaration initializer, assignment RHS — plain OR address-position —,
 *   swap replacements, bare-expression statements) are emitted through
 *   `emit_expr_from_nir`.
 * - handles `async_block` NIR-natively: the nursery body installs its own
 *   cursor from the lowered list.
 * - delegates every other statement kind to `build_node` unchanged.
 *
 * Method bodies and inline-expanded bodies don't go through
 * build_function_node; `build_body_with_cursor` (below) lowers + publishes
 * for them, so every executable statement list is cursor-driven.
 *
 * This is the seam where NIR facts attach to emission: later tranches add
 * liveness-gated decisions and the NEON vectorizer at exactly these dispatch
 * points (`emit_stmt_from_nir` for statements, `emit_expr_from_nir` for
 * expressions).
 */

export type { NirEmitCtx } from "../nir/emit_ctx.ts";

let nir_emission_on = true;

/** Kill-switch for A/B byte-identity tests (default: on). */
export function nir_emission_enabled(): boolean {
	return nir_emission_on;
}

export function set_nir_emission_enabled(enabled: boolean): void {
	nir_emission_on = enabled;
}

/**
 * Statement dispatch for build_block_node's loop: consume the index-aligned
 * NIR entry when the active ctx owns this statement list and the kind is
 * emitted NIR-natively; delegate to the AST walk otherwise.
 */
export function emit_stmt_from_nir(
	child: BaseNode,
	index: number,
	statements: readonly BaseNode[],
	status: BuildStatus,
): void {
	const ctx = status.nir_emit_ctx;
	if (ctx && nir_emission_on && ctx.ast === statements) {
		const nstmt = ctx.stmts[index];
		switch (nstmt.kind) {
			case "if":
				build_if_else_node(child as IfElseNode, status, nstmt);
				return;
			case "while":
				// NEON vectorization + full-unroll planning ride exactly this
				// dispatch point: the plans need the NIR list (init check +
				// post-loop reads), which only exists under an active cursor.
				// Null plans leave emission byte-identical to the scalar loop.
				build_while_loop_node(
					child as WhileLoopNode,
					status,
					nstmt,
					neon_vectorization_enabled() ? plan_vector_loop(nstmt, index, ctx.stmts, status) : null,
					plan_full_unroll(nstmt, index, ctx.stmts, status.induction_const),
				);
				return;
			case "for":
				// Range fors (`for i of 0 .. n`) vectorize like count-up
				// whiles: the builder self-initializes the induction to the
				// range start (zero-checked by the planner) and steps it by
				// one. Array/enumerable fors get a null plan and emit
				// unchanged.
				build_for_loop_node(
					child as ForLoopNode,
					status,
					nstmt,
					neon_vectorization_enabled() ? plan_vector_for(nstmt, index, ctx.stmts, status) : null,
				);
				return;
			case "switch_match":
				// `switch` and `match` lower to the same NIR kind (sequential
				// condition-chain); the AST node type picks the builder.
				if (child.node_type === "switch") {
					build_switch_node(child as SwitchNode, status, nstmt);
				} else {
					build_match_node(child as MatchNode, status, nstmt);
				}
				return;
			case "return":
				// Ownership/cleanup decisions stay on the AST node inside the
				// builder; the value expression (when any) is emitted through
				// the NIR expression seam. The trailing-newline replicates
				// build_node's with_semicolon tail so output is byte-identical
				// to the delegated path.
				build_return_node(child as ReturnNode, status, nstmt.value);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				return;
			case "declare":
				// Type/ownership routing stays on the AST node inside the
				// builder; the initializer (when any) is emitted through the
				// NIR expression seam. The trailing-newline guard replicates
				// build_node's with_semicolon tail: a `var func …`
				// declaration adds none.
				build_declaration_node(child as DeclarationNode, status, nstmt.decl.init, nstmt.decl.swap);
				if (nstmt.decl.init && nstmt.decl.init.node.node_type !== "func") {
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
				}
				return;
			case "assign":
				// Reclamation/aliasing decisions stay on the AST node inside
				// the builder; the RHS value (plain or address-position) and
				// the swap replacement are emitted through the NIR expression
				// seam. Trailing-newline replicates the delegated
				// with_semicolon tail. nstmt.node (NOT `child`): an arrow-arm
				// assignment (`case X -> t = v`) lowers from the LetNode
				// wrapping the assign expression, and the NIR stmt carries the
				// inner AssignmentNode the builder needs.
				build_assignment_node(nstmt.node as AssignmentNode, status, nstmt.rhs, nstmt.swap);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				return;
			case "eval": {
				// Expression-shaped statements (bare calls, lets): the value
				// rides the NIR expression seam. build_node's with_semicolon
				// path also stamps a bare nursery-spawn statement as
				// fire-and-forget — the seam bypasses that case, so replicate
				// the stamp here, then the usual newline tail.
				const eval_node = nstmt.expr.node;
				if (eval_node.node_type === "access") {
					const inner = (eval_node as AccessNode).access;
					if (
						inner.node_type === "access_func" &&
						(inner as AccessFunctionCallNode).is_nursery_spawn
					) {
						(inner as AccessFunctionCallNode).is_statement = true;
					}
				}
				emit_expr_from_nir(nstmt.expr, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				return;
			}
			case "async_block":
				// The nursery body is its own statement list: hand the builder
				// the lowered list so the body block dispatches NIR-natively
				// (scope frames and join emission stay in the builder).
				build_async_block_node(child as AsyncBlockNode, status, nstmt);
				return;
			default:
				// Everything else rides the existing AST emission unchanged;
				// later tranches take over more kinds here.
				break;
		}
	}
	build_node(child, status, true);
}

/**
 * Build a block with the NIR emission cursor pointed at `stmts` when
 * available, and CLEAR it when not — a delegated block (inline method body,
 * fallback function, spawn/async body…) must never consume an enclosing
 * block's cursor, even though the ctx identity guard would catch it.
 * Shared by every NIR-native builder (if/while/for/switch/match).
 */
export function build_block_with_cursor(
	block: BlockNode,
	stmts: readonly NirStmt[] | undefined,
	status: BuildStatus,
): void {
	const old_ctx = status.nir_emit_ctx;
	status.nir_emit_ctx = stmts ? { stmts, ast: block.statements } : undefined;
	build_block_node(block, status);
	status.nir_emit_ctx = old_ctx;
}

/**
 * Build a FUNCTION-LIKE body (struct/class/trait method, inline-expanded
 * method) with its own NIR emission cursor: the body is lowered once here so
 * every statement inside dispatches NIR-natively — these builds don't go
 * through build_function_node, which is what publishes the ctx for ordinary
 * functions. Restores the enclosing cursor afterwards.
 */
export function build_body_with_cursor(func: FunctionNode, status: BuildStatus): void {
	const nir = lower_function(func);
	if (nir.unknown_kinds.size > 0) {
		// Lowering is total over the checked AST; this is a compiler bug, not
		// user error — fail loudly instead of silently re-walking the AST.
		throw new Error(
			`NIR lowering gap in ${func.name || "<method>"}: ${[...nir.unknown_kinds].join(", ")}`,
		);
	}
	const old_ctx = status.nir_emit_ctx;
	status.nir_emit_ctx = { stmts: nir.body, ast: func.statements };
	build_block_node(func, status);
	status.nir_emit_ctx = old_ctx;
}

/**
 * NIR-level EXPRESSION emission (phase 4, stage 2 tranche 3).
 *
 * The expression seam: a value emission that runs while a NIR ctx owns the
 * enclosing statement list descends through here, so NIR facts (ref/swap
 * argument indices, receiver address-take marks, promoted-register leaves,
 * and — later — liveness-gated and NEON decisions) attach per-kind at
 * exactly one dispatch point.
 *
 * Byte-identity contract: every arm routes to the SAME builder the AST walk
 * picked for that node shape — via `build_node`, which also runs the hoisted
 * allocation pre-pass the AST path performed — with `grouped` recursing
 * through the NIR inner (build_node's grouped case is a pure pass-through,
 * so the NIR-side recursion is the same descent). Exhaustive over NirExpr:
 * a new expression kind is a compile error here until mapped.
 */
export function emit_expr_from_nir(expr: NirExpr, status: BuildStatus): void {
	switch (expr.kind) {
		case "leaf": // "value" → build_value_node
		case "binary": // "op" → build_operation_node / "range" → build_range_node
		case "call": // "func_call" → build_function_call_node / "array" literal
		case "method_call": // "access" → access_func → build_access_node
		case "path": // "access" field chain → build_access_node
		case "spawn": // value-position `spawn f(x)` → build_spawn_node
		case "other": // unreachable: lowering is total (build_function_node tripwires)
			build_node(expr.node, status);
			return;
		case "flow":
			// Value-position if/switch/match: the ORIGINAL node routes through
			// build_node to the same join-slot builders the AST walk picked
			// (status.return_assign makes each arm's value store into the join
			// slot); the IR's arm facts serve liveness, not emission.
			build_node(expr.node, status);
			return;
		case "wrap":
			if (expr.node.node_type === "grouped" && expr.inner) {
				emit_expr_from_nir(expr.inner, status);
			} else {
				// cast/let builders own their inner emission on the AST node.
				build_node(expr.node, status);
			}
			return;
	}
	const _exhaustive: never = expr;
	void _exhaustive;
}
