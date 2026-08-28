import type BuildStatus from "../build_c/BuildStatus.ts";
import type { NirStmt } from "../nir/nir.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_if_else_node from "./build_if_else_node.ts";
import build_node from "./build_node.ts";
import build_while_loop_node from "./build_while_loop_node.ts";

/**
 * NIR-driven emission (ASM_PLAN phase 4, canonical-IR stage 2).
 *
 * build_function_node lowers the body to NIR ONCE (shared with the promotion
 * planner) and, when the whole body mapped (`unknown_kinds` empty), points
 * `status.nir_emit_ctx` at the lowered statement list aligned 1:1 with the
 * body's AST statements. build_block_node's statement loop then dispatches
 * through `emit_stmt_from_nir`, which:
 *
 * - only consumes NIR entries when the ctx's `ast` IS the statement list
 *   being iterated (array identity). Any nested block build that doesn't own
 *   the list (inline method bodies, delegated for/switch/match branches,
 *   method bodies built from build_struct_node, spawn/async bodies…) sees a
 *   different array and falls back to the plain AST walk — misalignment is
 *   structurally impossible to corrupt emission with.
 * - handles `if`/`while` NIR-natively: the builders take the lowered branch/
 *   body lists and hand them to their nested blocks (label numbering, scope
 *   frames, buffer-cache snapshots and loop promotion stay in the builders,
 *   so both paths are the same code — no drift).
 * - delegates every other statement kind to `build_node` unchanged.
 *
 * This is the seam where NIR facts attach to emission: later tranches add
 * native `for`/`switch`/`match` lowering, liveness-gated decisions and the
 * NEON vectorizer at exactly this dispatch point.
 */

export interface NirEmitCtx {
	/** Lowered statements, index-aligned with `ast` (from_ast is 1:1). */
	stmts: readonly NirStmt[];
	/** The exact AST statement list this ctx drives (identity-checked). */
	ast: readonly BaseNode[];
}

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
				build_while_loop_node(child as WhileLoopNode, status, nstmt);
				return;
			default:
				// Everything else rides the existing AST emission unchanged
				// (tranche 1); later tranches take over more kinds here.
				break;
		}
	}
	build_node(child, status, true);
}
