import type { NirStmt } from "../nir/nir.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import MatchNode from "../nodes/MatchNode.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_block_node from "./build_block_node.ts";
import build_for_loop_node from "./build_for_loop_node.ts";
import build_if_else_node from "./build_if_else_node.ts";
import build_match_node from "./build_match_node.ts";
import build_node from "./build_node.ts";
import build_switch_node from "./build_switch_node.ts";
import build_while_loop_node from "./build_while_loop_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/**
 * NIR-driven emission — C BACKEND (ASM_PLAN phase 4, canonical-IR stage 2+).
 *
 * Mirrors `build_aarch64/emit_nir.ts`: build_function_node lowers the body to
 * NIR ONCE and, when the whole body mapped (`unknown_kinds` empty), points
 * `status.nir_emit_ctx` at the lowered statement list aligned 1:1 with the
 * body's AST statements. build_block_node's statement loop then dispatches
 * through `emit_stmt_from_nir`, which:
 *
 * - only consumes NIR entries when the ctx's `ast` IS the statement list
 *   being iterated (array identity). Any nested block build that doesn't own
 *   the list (inline method bodies, spawn/async bodies, method bodies built
 *   from build_struct_node…) sees a different array and falls back to the
 *   plain AST walk — misalignment structurally cannot corrupt emission.
 * - handles `if`/`while`/`for`/`switch`/`match` NIR-natively: the builders
 *   take the lowered branch/body lists and hand them to their nested blocks
 *   (scope frames, deferred frees, auto-free, loop writebacks and condition
 *   emission stay in the builders, so both paths are the same code — no
 *   drift).
 * - delegates every other statement kind to `build_node` unchanged; later
 *   tranches take over `return`/`declare`/`assign`/`eval` at this same
 *   dispatch point (their takeover is the expression seam, which for C routes
 *   through the shared `build_node` hoisted-allocation pre-pass).
 *
 * This is the seam where NIR facts attach to C emission: later tranches add
 * liveness-gated decisions at exactly these dispatch points.
 */

let c_nir_emission_on = true;

/** Kill-switch for A/B byte-identity tests (default: on). */
export function c_nir_emission_enabled(): boolean {
	return c_nir_emission_on;
}

export function set_c_nir_emission_enabled(enabled: boolean): void {
	c_nir_emission_on = enabled;
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
	if (ctx && c_nir_emission_on && ctx.ast === statements) {
		const nstmt = ctx.stmts[index];
		switch (nstmt.kind) {
			case "if":
				build_if_else_node(child as IfElseNode, status, nstmt);
				return;
			case "while":
				build_while_loop_node(child as WhileLoopNode, status, nstmt);
				return;
			case "for":
				build_for_loop_node(child as ForLoopNode, status, nstmt);
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
 * available, and CLEAR it when not — a delegated block (spawn/async body,
 * fallback function…) must never consume an enclosing block's cursor, even
 * though the ctx identity guard would catch it. Shared by every NIR-native
 * C builder (if/while/for/switch/match).
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
