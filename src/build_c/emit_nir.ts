import { lower_function } from "../nir/from_ast.ts";
import type { NirExpr, NirStmt } from "../nir/nir.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import { is_function_node, is_struct_node, is_trait_node } from "../nodes/check_node_type.ts";
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
import type BuildStatus from "./BuildStatus.ts";
import emit_allocations from "./utils/emit_allocations.ts";

/**
 * NIR-driven emission — C BACKEND (ASM_PLAN phase 4, canonical-IR stage 2+).
 *
 * Mirrors `build_aarch64/emit_nir.ts`: build_function_node lowers the body to
 * NIR ONCE and — lowering being TOTAL over the checked AST — publishes the
 * ctx for EVERY function body; the whole-function AST fallback is retired (a
 * residual unknown kind is a tripwire throw). build_block_node's statement
 * loop then dispatches through `emit_stmt_from_nir`, which:
 *
 * - only consumes NIR entries when the ctx's `ast` IS the statement list
 *   being iterated (array identity). Any nested block build that doesn't own
 *   the list (synthetic statement fragments like #init constructor bodies…)
 *   sees a different array and falls back to the plain AST walk —
 *   misalignment structurally cannot corrupt emission.
 * - handles `if`/`while`/`for`/`switch`/`match` NIR-natively: the builders
 *   take the lowered branch/body lists and hand them to their nested blocks
 *   (scope frames, deferred frees, auto-free, loop writebacks and condition
 *   emission stay in the builders, so both paths are the same code — no
 *   drift).
 * - handles `return`/`declare`/`assign`/`eval` NIR-natively: the builders keep
 *   every semantic decision (type routing, ownership/reclamation, aliasing,
 *   move marks, borrow normalization, swap marshalling) on the AST node, and
 *   the VALUE positions (return expression, declaration initializer, plain +
 *   string-field + trait-dispatch assignment RHS, swap replacements, bare
 *   expression statements) descend `emit_expr_from_nir` (the expression seam
 *   below). The trailing `with_semicolon_tail` replicates build_node's
 *   with_semicolon tail byte-exactly (including the historical `;` line after
 *   returns and the deferred string-release flush).
 * - handles `async_block` NIR-natively: the nursery body installs its own
 *   cursor from the lowered list.
 * - delegates every other statement kind to `build_node` unchanged.
 *
 * Method bodies (built by build_struct_node's own statement loop, not
 * build_block_node) dispatch through `emit_method_body_from_nir` (below), so
 * every executable statement list is cursor-driven.
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
			case "return":
				// Ownership/borrow-normalization decisions stay on the AST node
				// inside the builder; the value expression (when any) descends
				// the NIR expression seam. build_return_node emits its own `;\n`
				// (or nothing for a from_inline return, which the delegated path
				// also leaves un-terminated) — the tail replicates build_node's
				// with_semicolon suffix exactly.
				build_return_node(child as ReturnNode, status, nstmt.value);
				if (!(child as ReturnNode).from_inline) {
					with_semicolon_tail(status);
				}
				return;
			case "declare":
				// Type/ownership routing stays on the AST node inside the
				// builder; the initializer (when any) descends the NIR
				// expression seam. Only a func-valued declaration skips the
				// tail (build_node's parity rule) — a declaration with NO
				// initializer still gets one.
				build_declaration_node(child as DeclarationNode, status, nstmt.decl.init, nstmt.decl.swap);
				if (!nstmt.decl.init || nstmt.decl.init.node.node_type !== "func") {
					with_semicolon_tail(status);
				}
				return;
			case "assign":
				// Reclamation/aliasing decisions stay on the AST node inside
				// the builder; the RHS value (plain, string-field, trait
				// dispatch, ref-param write…) and the swap replacement descend
				// the NIR expression seam. nstmt.node (NOT `child`): an
				// arrow-arm assignment (`case X -> t = v`) lowers from the
				// LetNode wrapping the assign expression, and the NIR stmt
				// carries the inner AssignmentNode the builder needs.
				build_assignment_node(nstmt.node as AssignmentNode, status, nstmt.rhs, nstmt.swap);
				with_semicolon_tail(status);
				return;
			case "eval": {
				// Expression-shaped statements (bare calls, lets): the value
				// descends the NIR expression seam. build_node's with_semicolon
				// path also stamps a bare nursery-spawn statement as
				// fire-and-forget — the seam bypasses that case, so replicate
				// the stamp here, then the usual tail.
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
				with_semicolon_tail(status);
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

/**
 * Emit a struct/class/trait METHOD body through the NIR dispatch. C methods
 * don't go through build_block_node/build_function_node — build_struct_node
 * iterates `func.statements` directly — so without this they would be the
 * one remaining statement list the AST walk still drove. Same loop shape as
 * build_block_node's statement loop (type/function skip guards, per-statement
 * allocation surfacing, NIR dispatch), minus the root-scope gating that only
 * applies to top-level blocks.
 */
export function emit_method_body_from_nir(func: FunctionNode, status: BuildStatus): void {
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
	for (let index = 0; index < func.statements.length; index++) {
		const child = func.statements[index];
		if (
			!is_trait_node(child) &&
			!is_struct_node(child) &&
			!is_function_node(child) &&
			child.node_type !== "enum" &&
			child.node_type !== "bitset"
		) {
			emit_allocations(child, status);
			emit_stmt_from_nir(child, index, func.statements, status);
		}
	}
	status.nir_emit_ctx = old_ctx;
}

/**
 * Replicates build_node's `with_semicolon` tail EXACTLY (the C backend's
 * historical statement terminator: `;\n` unless the emitted code ended a
 * block, plus the deferred string-release flush). The NIR-native statement
 * arms call it so their output is byte-identical to the delegated
 * `build_node(child, status, true)` path.
 */
function with_semicolon_tail(status: BuildStatus): void {
	if (!status.code.endsWith("}\n")) {
		status.code += ";\n";
	}
	// Flush frees deferred from mov call sites inside this statement
	// (VALUE-struct string fields — see build_access_node /
	// build_function_call_node). Appending them at the call itself would
	// break the surrounding expression.
	if (status.pending_string_releases?.length) {
		status.code += status.pending_string_releases.join("\n") + "\n";
		status.pending_string_releases.length = 0;
	}
}

/**
 * NIR-level EXPRESSION emission (phase 4, canonical-IR stage 2+ — the C
 * expression seam).
 *
 * A value emission that runs while a NIR ctx owns the enclosing statement
 * list descends through here, so NIR facts (ref/swap argument indices,
 * receiver address-take marks, and — later — liveness-gated decisions)
 * attach per-kind at exactly one dispatch point.
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
		case "flow": // value-position if/switch/match → join-slot builders via build_node
		case "other": // unreachable: lowering is total (build_function_node tripwires)
			build_node(expr.node, status);
			return;
		case "wrap":
			// Unlike the aarch64 backend (whose grouped case is a pure value
			// pass-through), C's grouped case EMITS the parentheses into the
			// expression text — so the wrap recursion must go through
			// build_node. Cast/let builders likewise own their inner emission
			// on the AST node.
			build_node(expr.node, status);
			return;
	}
	const _exhaustive: never = expr;
	void _exhaustive;
}

/**
 * The lowered NIR exprs for an array literal: array literals lower to a
 * `call` whose args are the index-aligned elements — undefined when the
 * lowered expr isn't this exact node. Consumed by the declaration/return
 * array-literal element sites so each element descends the seam.
 */
export function nir_array_elements(
	nir: NirExpr | null | undefined,
	arr: BaseNode | null | undefined,
): readonly NirExpr[] | undefined {
	return nir?.kind === "call" && nir.node === arr ? nir.facts.args : undefined;
}
