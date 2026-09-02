import type BuildStatus from "../build_c/BuildStatus.ts";
import { is_float_type, is_scalar_type } from "../built_in_types.ts";
import { is_int_literal, parse_int_literal_bigint } from "../int_literal.ts";
import type { NirEmitCtx } from "../nir/emit_ctx.ts";
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
import ValueNode from "../nodes/ValueNode.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_assignment_node from "./build_assignment_node.ts";
import build_async_block_node from "./build_async_block_node.ts";
import build_block_node from "./build_block_node.ts";
import build_declaration_node from "./build_declaration_node.ts";
import build_for_loop_node from "./build_for_loop_node.ts";
import build_if_else_node from "./build_if_else_node.ts";
import build_match_node from "./build_match_node.ts";
import build_node from "./build_node.ts";
import { cond_is_cset_eligible, emit_cond_cset } from "./build_operation_node.ts";
import build_return_node from "./build_return_node.ts";
import build_switch_node from "./build_switch_node.ts";
import build_while_loop_node from "./build_while_loop_node.ts";
import { cset_lowering_enabled } from "./cset_lower.ts";
import { apply_forward_use, cset_flag_is_write_only, prepare_nir_forwarding } from "./forward.ts";
import { neon_vectorization_enabled } from "./neon_emit.ts";
import { plan_vector_for, plan_vector_loop } from "./neon_plan.ts";
import { plan_full_unroll } from "./unroll.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_var_store } from "./utils/stack_var.ts";

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
 * emitted NIR-natively; delegate to the AST walk otherwise. Returns the
 * number of statements consumed — normally 1; the cset fuse (tranche B)
 * consumes the declare AND its following if and returns 2.
 */
export function emit_stmt_from_nir(
	child: BaseNode,
	index: number,
	statements: readonly BaseNode[],
	status: BuildStatus,
): number {
	const ctx = status.nir_emit_ctx;
	if (ctx && nir_emission_on && ctx.ast === statements) {
		const nstmt = ctx.stmts[index];
		switch (nstmt.kind) {
			case "if":
				build_if_else_node(child as IfElseNode, status, nstmt);
				return 1;
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
				return 1;
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
				return 1;
			case "switch_match":
				// `switch` and `match` lower to the same NIR kind (sequential
				// condition-chain); the AST node type picks the builder.
				if (child.node_type === "switch") {
					build_switch_node(child as SwitchNode, status, nstmt);
				} else {
					build_match_node(child as MatchNode, status, nstmt);
				}
				return 1;
			case "return": {
				// Ownership/cleanup decisions stay on the AST node inside the
				// builder; the value expression (when any) is emitted through
				// the NIR expression seam. The trailing-newline replicates
				// build_node's with_semicolon tail so output is byte-identical
				// to the delegated path.
				const restore_return = apply_forward_use(ctx.use_sites, nstmt.node);
				try {
					build_return_node(child as ReturnNode, status, nstmt.value);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					return 1;
				} finally {
					restore_return?.();
				}
			}
			case "declare":
				// Decl-site binding (stage 3): a register the allocator gave
				// this DECLARE SITE binds here, into the CURRENT scope
				// frame's map — two sibling scopes declaring the same name
				// each bind their own register at their own declare. Reads
				// before the declare (its initializer's operands) resolve to
				// the enclosing binding or the slot; reads after resolve to
				// this register. Frames die at exit_scope_frame, so the
				// binding never leaks past its scope.
				//
				// A name ALREADY bound keeps its existing binding: an
				// enclosing loop's promotion bracketed it (entry load, exit
				// store-back, name-keyed binding), and the loop pass cannot
				// know a site register will override it mid-body — the two
				// claim systems can otherwise hand one register to two
				// simultaneously-live variables (the div_to receipt: the
				// D2-loop claimed pi→x13 and lo_prod→x14, then the site hook
				// rebound lo_prod to its plan register x13, and the inner
				// product loop wrote lo_prod over the induction). The site's
				// planned register simply goes unused — the loop's slot
				// bracketing keeps every access coherent.
				{
					const site = status.nir_site_allocs?.get(nstmt.decl.key);
					if (site && !status.register_allocations?.has(nstmt.decl.name)) {
						if (!status.register_allocations) status.register_allocations = new Map();
						status.register_allocations.set(nstmt.decl.name, site.reg);
					}
				}
				// Stage-4 forward plan (see forward.ts): this declare may be
				// another declare's single use. Swap the leaf AST for the
				// declaring initializer while this statement builds, restore
				// after — the cset gate, tree counter, operand selectors and
				// builders all see the substituted tree; nothing else does.
				// A forwarded def site emits nothing — its initializer is
				// re-emitted at the single use (scalar declares carry no
				// registration the builder provides).
				if (ctx.forward_defs?.has(nstmt.decl.node)) {
					return 1;
				}
				const restore_decl = apply_forward_use(ctx.use_sites, nstmt.decl.node);
				try {
					// Cset fuse (ASM_PLAN_3 tranche B): `var x = 0; if <pure
					// scalar cmp> { x = 1 }` lowers as one branch-free
					// declare + cmp/cset + store, consuming both statements.
					const consumed = try_emit_cset_pair(child as DeclarationNode, nstmt, index, ctx, status);
					if (consumed === 2) {
						return 2;
					}
					// Type/ownership routing stays on the AST node inside the
					// builder; the initializer (when any) is emitted through
					// the NIR expression seam. The trailing-newline guard
					// replicates build_node's with_semicolon tail: a `var
					// func …` declaration adds none.
					build_declaration_node(
						child as DeclarationNode,
						status,
						nstmt.decl.init,
						nstmt.decl.swap,
					);
					if (nstmt.decl.init && nstmt.decl.init.node.node_type !== "func") {
						if (!status.code.endsWith("\n")) {
							status.code += "\n";
						}
					}
					return 1;
				} finally {
					restore_decl?.();
				}
			case "assign": {
				// Reclamation/aliasing decisions stay on the AST node inside
				// the builder; the RHS value (plain or address-position) and
				// the swap replacement are emitted through the NIR expression
				// seam. Trailing-newline replicates the delegated
				// with_semicolon tail. nstmt.node (NOT `child`): an arrow-arm
				// assignment (`case X -> t = v`) lowers from the LetNode
				// wrapping the assign expression, and the NIR stmt carries the
				// inner AssignmentNode the builder needs.
				const restore_assign = apply_forward_use(ctx.use_sites, nstmt.node);
				try {
					build_assignment_node(nstmt.node as AssignmentNode, status, nstmt.rhs, nstmt.swap);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					return 1;
				} finally {
					restore_assign?.();
				}
			}
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
				const restore_eval = apply_forward_use(ctx.use_sites, nstmt.expr.node);
				try {
					emit_expr_from_nir(nstmt.expr, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					return 1;
				} finally {
					restore_eval?.();
				}
			}
			case "async_block":
				// The nursery body is its own statement list: hand the builder
				// the lowered list so the body block dispatches NIR-natively
				// (scope frames and join emission stay in the builder).
				build_async_block_node(child as AsyncBlockNode, status, nstmt);
				return 1;
			default:
				// Everything else rides the existing AST emission unchanged;
				// later tranches take over more kinds here.
				break;
		}
	}
	build_node(child, status, true);
	return 1;
}

/**
 * Cset fuse (ASM_PLAN_3 tranche B): match `var x = 0` immediately followed
 * by `if <pure scalar comparison> { x = 1 }` (no else, single-statement
 * branch) and emit the declare plus one branch-free `cmp/cset` + store to
 * x's home. Returns 2 when the pair was consumed (the caller's loop skips
 * the if), 1 to fall back to the ordinary per-statement emission. Every
 * gate that fails keeps the branches — see cset_lower.ts for the
 * soundness model.
 */
function try_emit_cset_pair(
	decl: DeclarationNode,
	nstmt: NirStmt & { kind: "declare" },
	index: number,
	ctx: NirEmitCtx,
	status: BuildStatus,
): number {
	if (!cset_lowering_enabled()) return 1;
	// `var x = 0` — mutable, scalar-typed, literal-zero initializer.
	if (decl.declaration !== "var") return 1;
	const init = decl.value;
	if (
		!init ||
		init.node_type !== "value" ||
		typeof (init as ValueNode).value !== "string" ||
		!is_int_literal((init as ValueNode).value) ||
		!parse_zero_literal((init as ValueNode).value)
	) {
		return 1;
	}
	if (is_float_type(decl.type?.name ?? "") || !is_scalar_type(decl.type?.name ?? "int")) {
		return 1;
	}
	// ... immediately followed by the if (AST + NIR entries must agree).
	const next = ctx.ast[index + 1];
	const nnext = ctx.stmts[index + 1];
	if (!next || !nnext || next.node_type !== "if" || nnext.kind !== "if") return 1;
	const ifn = next as IfElseNode;
	if (ifn.else_branch) return 1;
	const body = ifn.if_branch?.statements ?? [];
	if (body.length !== 1) return 1;
	// ... whose only statement is the flag write `x = 1`.
	const assign = body[0] as AssignmentNode;
	if (assign.node_type !== "assign") return 1;
	const lhs = assign.left_value;
	if (!lhs || lhs.node_type !== "value" || (lhs as ValueNode).value !== decl.name) return 1;
	if (assign.operator !== undefined) return 1;
	const rhs = assign.right_value;
	if (!rhs || rhs.node_type !== "value" || (rhs as ValueNode).value !== "1") return 1;
	// ... and the condition must be a plain scalar comparison.
	if (!cond_is_cset_eligible(ifn.condition)) return 1;

	// Stage-4 elision: the flag is never read anywhere — the whole
	// cmp/cset/store tail is dead. The declare still builds below
	// (registration semantics preserved); only the tail is skipped.
	const flag_dead = cset_flag_is_write_only(ctx, decl.name);

	// Emit: the declare (registers the name, stores the 0 — every
	// registration/scope semantic preserved), then the comparison
	// materialized straight into x0 and stored to the same home.
	build_declaration_node(decl, status, nstmt.decl.init, nstmt.decl.swap);
	if (nstmt.decl.init && nstmt.decl.init.node.node_type !== "func") {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}
	if (flag_dead) {
		return 2;
	}
	emit_cond_cset(ifn.condition, status);
	emit_var_store(status, "x0", decl.name, aarch64_size(decl.type?.name ?? "int"));
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
	return 2;
}

/** True when the literal string is exactly the integer 0 (decimal or hex). */
function parse_zero_literal(value: string): boolean {
	return parse_int_literal_bigint(value)?.toString() === "0";
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
	// Nested blocks continue the enclosing body's cursor: the statement
	// lists differ (this block's), but the stage-4 analysis facts
	// (write_only flags, forward use sites) belong to the WHOLE function
	// body and ride every nested cursor.
	status.nir_emit_ctx = stmts
		? {
				stmts,
				ast: block.statements,
				write_only: old_ctx?.write_only,
				use_sites: old_ctx?.use_sites,
				forward_defs: old_ctx?.forward_defs,
			}
		: undefined;
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
	// Stage 4 (ASM_PLAN_3): single-use forwarding + write-only flag facts,
	// computed against the SAME plan (register_allocations / nir_site_allocs)
	// the emission below will consult. The pass returns a fresh spine for
	// rewritten statements; publishing THAT list (not nir.body) keeps the
	// shared lowering object untouched.
	const prepared = prepare_nir_forwarding(nir.body, status);
	const old_ctx = status.nir_emit_ctx;
	status.nir_emit_ctx = {
		stmts: prepared.stmts,
		ast: func.statements,
		write_only: prepared.write_only,
		use_sites: prepared.use_sites,
		forward_defs: prepared.forward_defs,
	};
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
