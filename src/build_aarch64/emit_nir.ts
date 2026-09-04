import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { is_float_type, is_scalar_type, is_unsigned_int_type } from "../built_in_types.ts";
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
import OperationNode from "../nodes/OperationNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import { note_dispatched_statement, pins_taint } from "./access_staging.ts";
import build_assignment_node from "./build_assignment_node.ts";
import build_async_block_node from "./build_async_block_node.ts";
import build_block_node from "./build_block_node.ts";
import build_declaration_node from "./build_declaration_node.ts";
import build_for_loop_node from "./build_for_loop_node.ts";
import build_if_else_node from "./build_if_else_node.ts";
import build_match_node from "./build_match_node.ts";
import build_node from "./build_node.ts";
import { cond_is_cset_eligible, emit_cond_cset, build_operand } from "./build_operation_node.ts";
import build_return_node from "./build_return_node.ts";
import build_switch_node from "./build_switch_node.ts";
import build_while_loop_node from "./build_while_loop_node.ts";
import { cset_lowering_enabled } from "./cset_lower.ts";
import { flag_form_enabled } from "./flag_form.ts";
import { apply_forward_use, cset_flag_is_write_only, prepare_nir_forwarding } from "./forward.ts";
import { neon_vectorization_enabled } from "./neon_emit.ts";
import { plan_vector_for, plan_vector_loop } from "./neon_plan.ts";
import { plan_full_unroll } from "./unroll.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_var_load, emit_var_store } from "./utils/stack_var.ts";
import { value_number_loops } from "./value_number.ts";

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
 *
 * The exported wrapper also notes the dispatched span for the
 * access-staging pin window (ASM_PLAN_3 tranche L): plain declares/assigns
 * record their written names, fused cset/carry-fold spans are pure flag
 * materialization, everything else taints.
 */
export function emit_stmt_from_nir(
	child: BaseNode,
	index: number,
	statements: readonly BaseNode[],
	status: BuildStatus,
): number {
	const ctx = status.nir_emit_ctx;
	const owned = !!(ctx && nir_emission_on && ctx.ast === statements);
	const kind = owned ? ctx!.stmts[index]!.kind : "";
	const consumed = emit_stmt_dispatch(child, index, statements, status);
	note_dispatched_statement(kind, statements.slice(index, index + consumed), status);
	return consumed;
}

function emit_stmt_dispatch(
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
					// Carry-fold fuse (ASM_PLAN_3 tranche J): a scalar declare
					// whose init is a plain `+`/`-` of names, followed by (up
					// to one flag-safe assign and) a fused carry compare —
					// `var c = 0; if prod < a { c = 1 }` or
					// `if prod < a { x += 1 }` — lowers the root op as
					// adds/subs and materializes the flag from its carry/borrow
					// flags. Consumes 2-4 statements.
					const carried = try_emit_carry_fold(child as DeclarationNode, nstmt, index, ctx, status);
					if (carried > 1) {
						return carried;
					}
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
	// cmp/cset/store tail is dead.
	const flag_dead = cset_flag_is_write_only(ctx, decl.name);
	if (flag_dead) {
		return 2;
	}
	// Stage-5 dest hint: a flag with a promoted register home takes the
	// cset directly (`cset xN, cc` — no x0 staging, no store) and its
	// literal-0 initializer is dead (the fused cset overwrites it before
	// any possible read — tranche B's contract). The declare is skipped
	// ENTIRELY here: frame slots allocate at declare-emission, so the skip
	// is only sound when no slot is ever needed. A swap-bearing declare
	// keeps the full builder path (ownership semantics).
	const flag_reg = status.register_allocations?.get(decl.name);
	if (flag_reg?.startsWith("x") && !nstmt.decl.swap) {
		emit_cond_cset(ifn.condition, status, flag_reg);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		return 2;
	}
	// Slot-home flag: the declare allocates the flag's frame slot, then the
	// comparison materializes into x0 and stores to the same home.
	build_declaration_node(decl, status, nstmt.decl.init, nstmt.decl.swap);
	if (nstmt.decl.init && nstmt.decl.init.node.node_type !== "func") {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
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

function carry_unwrap_grouped(node: BaseNode | undefined): BaseNode {
	let n = node as BaseNode;
	while (n && n.node_type === "grouped") {
		n = (n as unknown as { value?: BaseNode }).value as BaseNode;
	}
	return n;
}

function carry_value_name(node: BaseNode): string | null {
	const v = carry_unwrap_grouped(node);
	if (!v || v.node_type !== "value") return null;
	const value = (v as ValueNode).value;
	return typeof value === "string" && !is_int_literal(value) ? value : null;
}

function carry_is_plain_literal(node: BaseNode): string | null {
	const v = carry_unwrap_grouped(node);
	if (!v || v.node_type !== "value") return null;
	const value = (v as ValueNode).value;
	return typeof value === "string" && is_int_literal(value) ? value : null;
}

function carry_is_unsigned_value(node: BaseNode): boolean {
	const v = carry_unwrap_grouped(node);
	if (!v) return false;
	return is_unsigned_int_type(type_from_value_node(v)?.name ?? "");
}

function carry_invert_cond(c: string): string {
	return c === "hs" ? "lo" : "hs";
}

/**
 * Carry-fold fuse (ASM_PLAN_3 tranche J): match a scalar declare whose
 * initializer is a plain `a + b` / `a - b`, followed by (at most ONE
 * flag-safe plain assign, e.g. `mul_carry = hi_prod`) and a materialized
 * carry/borrow compare — either the tranche-B flag shape
 * (`var c = 0; if prod < a { c = 1 }`) or the compound-assign shape
 * (`if prod < a { x += 1 }`). The comparison `<` over an add (or `>`
 * over a sub) IS the flag the arithmetic sets, so the declare's root op
 * lowers to adds/subs (the one-shot arm in flag_form.ts, consumed by
 * map_op) and the tail is one cset — or one cinc when the compound
 * target's home is a promoted register (clang's `adds; cinc` idiom).
 *
 * Unsigned-only: `<` after `+` and `>` after `-` are the carry/borrow
 * flag for unsigned arithmetic; signed overflow is not flag-equivalent,
 * and `==`/`!=`/`<`-after-`-`/`>`-after-`+` have no flag form — every
 * such shape declines and emits exactly as before.
 *
 * Flags survive `mov`/`ldr`/`str` only: every instruction the gated
 * window can emit between the adds and the cset/cinc is one of those.
 *
 * Returns the number of statements consumed (2-4), or 1 to fall through
 * to the ordinary paths (including the tranche-B fuse, whose write-only
 * elision and dest-hint tails stay authoritative for their own shapes).
 */
function try_emit_carry_fold(
	decl: DeclarationNode,
	nstmt: NirStmt & { kind: "declare" },
	index: number,
	ctx: NirEmitCtx,
	status: BuildStatus,
): number {
	if (!flag_form_enabled()) return 1;
	if (nstmt.decl.swap) return 1;
	// prod: scalar, non-float, const or var.
	const decl_type = decl.type?.name ?? "int";
	if (is_float_type(decl_type) || !is_scalar_type(decl_type)) return 1;
	// init: exactly `<name|literal> +|- <name|literal>` (not both literals).
	const init = carry_unwrap_grouped(decl.value);
	if (!init || init.node_type !== "op") return 1;
	const init_op = init as OperationNode;
	if (init_op.op !== "+" && init_op.op !== "-") return 1;
	if (!init_op.left_value || !init_op.right_value) return 1;
	const left_name =
		carry_value_name(init_op.left_value) ?? carry_is_plain_literal(init_op.left_value);
	const right_name =
		carry_value_name(init_op.right_value) ?? carry_is_plain_literal(init_op.right_value);
	if (left_name === null || right_name === null) return 1;
	if (is_int_literal(left_name) && is_int_literal(right_name)) return 1;
	// Identifier operands must be non-float scalars (literals are fine).
	for (const side of [init_op.left_value, init_op.right_value]) {
		const name = carry_value_name(side);
		if (name === null) continue;
		const tn = type_from_value_node(carry_unwrap_grouped(side)!)?.name ?? "";
		if (is_float_type(tn) || !is_scalar_type(tn)) return 1;
	}

	// Forward scan: at most one flag-safe plain assign, then the pair/if.
	let j = index + 1;
	const intervening: (NirStmt & { readonly kind: "assign" })[] = [];
	const flag_decl_at = (k: number) => {
		const a = ctx.ast[k];
		const n = ctx.stmts[k];
		if (!a || !n || a.node_type !== "declare" || n.kind !== "declare") return null;
		return { ast: a as DeclarationNode, n };
	};
	const if_at = (k: number) => {
		const a = ctx.ast[k];
		const n = ctx.stmts[k];
		if (!a || !n || a.node_type !== "if" || n.kind !== "if") return null;
		return { ast: a as IfElseNode, n };
	};

	let flag = flag_decl_at(j);
	let branch = flag ? null : if_at(j);
	if (!flag && !branch) {
		const a = ctx.ast[j];
		const n = ctx.stmts[j];
		if (a && n && a.node_type === "assign" && n.kind === "assign") {
			const assign = a as AssignmentNode;
			// Flag-safe plain assign: `name = <name|literal>`, scalar target,
			// no compound operator, no swap, target is not prod.
			if (
				assign.operator === undefined &&
				n.operator === null &&
				n.swap === null &&
				assign.left_value &&
				assign.right_value &&
				carry_value_name(assign.left_value) !== null &&
				(carry_value_name(assign.right_value) !== null ||
					carry_is_plain_literal(assign.right_value) !== null) &&
				carry_value_name(assign.left_value) !== decl.name
			) {
				const tn = type_from_value_node(carry_unwrap_grouped(assign.left_value)!)?.name ?? "";
				if (!is_float_type(tn) && is_scalar_type(tn)) {
					intervening.push(n);
					j += 1;
					flag = flag_decl_at(j);
					branch = flag ? null : if_at(j);
				}
			}
		}
	}
	if (!flag && !branch) return 1;

	// The if: no else, and its condition unwraps to an unsigned comparison
	// `prod <op> <source name>` with a flag equivalent.
	const ifn = (branch?.ast ?? (flag ? if_at(j + 1)?.ast : undefined)) as IfElseNode | undefined;
	if (!ifn || ifn.else_branch) return 1;
	const body = ifn.if_branch?.statements ?? [];
	if (body.length !== 1) return 1;

	let cond: BaseNode | undefined = ifn.condition;
	let negated = false;
	for (;;) {
		const u = carry_unwrap_grouped(cond);
		if (u && u.node_type === "op" && (u as OperationNode).op === "!") {
			negated = !negated;
			cond = (u as OperationNode).left_value ?? (u as OperationNode).right_value;
			continue;
		}
		cond = u;
		break;
	}
	if (!cond || cond.node_type !== "op") return 1;
	const cmp_node = cond as OperationNode;
	if (cmp_node.op !== "<" && cmp_node.op !== ">" && cmp_node.op !== ">=" && cmp_node.op !== "<=") {
		return 1;
	}
	if (carry_value_name(cmp_node.left_value) !== decl.name) return 1;
	const source_name = carry_value_name(cmp_node.right_value);
	if (source_name === null || (source_name !== left_name && source_name !== right_name)) return 1;
	if (
		!carry_is_unsigned_value(cmp_node.left_value) ||
		!carry_is_unsigned_value(cmp_node.right_value)
	) {
		return 1;
	}
	const base =
		init_op.op === "+"
			? cmp_node.op === "<"
				? "hs"
				: cmp_node.op === ">="
					? "lo"
					: null
			: cmp_node.op === ">"
				? "lo"
				: cmp_node.op === "<="
					? "hs"
					: null;
	if (base === null) return 1;
	const cc = negated ? carry_invert_cond(base) : base;

	// prod must have a promoted register home: the fold emits the root op
	// DIRECTLY into it (the declare builder is skipped — the G-tranche
	// precedent: a register home never needs the frame slot the builder
	// allocates), and a slot home has no flag-form path.
	const prod_reg = status.register_allocations?.get(decl.name);
	if (!prod_reg?.startsWith("x")) return 1;

	const emit_decl_with_flags = (): void => {
		// prod's declare, emitted directly with the root op in flag form.
		// Promoted operands are used IN PLACE (the same selector contract as
		// build_operation_node's int fast path: params and unrolled-copy
		// inductions excluded — the mandelbrot corruption receipt); the rest
		// stage through build_operand into x0/x1. Operand order is
		// preserved: `subs prod, left, right`.
		const in_place = (side: BaseNode): string | null => {
			const v = carry_unwrap_grouped(side);
			if (!v || v.node_type !== "value") return null;
			const name = (v as ValueNode).value;
			if (typeof name !== "string" || is_int_literal(name)) return null;
			if (status.function_param_regs?.has(name)) return null;
			if (status.induction_const?.has(name)) return null;
			const reg = status.register_allocations?.get(name);
			return reg && reg.startsWith("x") ? reg : null;
		};
		const ls = in_place(init_op.left_value);
		const rs = in_place(init_op.right_value);
		const mnemonic = init_op.op === "+" ? "adds" : "subs";
		if (ls && rs) {
			status.code += `${mnemonic} ${prod_reg}, ${ls}, ${rs}\n`;
		} else if (ls) {
			build_operand(init_op.right_value, "x0", status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			status.code += `${mnemonic} ${prod_reg}, ${ls}, x0\n`;
		} else if (rs) {
			build_operand(init_op.left_value, "x0", status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			status.code += `${mnemonic} ${prod_reg}, x0, ${rs}\n`;
		} else {
			build_operand(init_op.right_value, "x2", status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			build_operand(init_op.left_value, "x1", status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			status.code += `${mnemonic} ${prod_reg}, x1, x2\n`;
		}
	};
	const emit_intervening = (): void => {
		for (const s of intervening) {
			const restore = apply_forward_use(ctx.use_sites, s.node);
			try {
				build_assignment_node(s.node as AssignmentNode, status, s.rhs, s.swap);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
			} finally {
				restore?.();
			}
		}
	};

	if (flag) {
		// Form A: the zero-flag declare + `flag = 1`. The write-only
		// elision and the G dest-hint tails stay the tranche-B fuse's
		// business — decline and let it handle them (without the adds).
		const fd = flag;
		if (fd.ast.declaration !== "var") return 1;
		const fd_init = fd.ast.value;
		if (
			!fd_init ||
			fd_init.node_type !== "value" ||
			typeof (fd_init as ValueNode).value !== "string" ||
			!parse_zero_literal((fd_init as ValueNode).value)
		) {
			return 1;
		}
		const fd_type = fd.ast.type?.name ?? "int";
		if (is_float_type(fd_type) || !is_scalar_type(fd_type)) return 1;
		const fd_assign = body[0] as AssignmentNode;
		if (fd_assign.node_type !== "assign" || fd_assign.operator !== undefined) return 1;
		if (carry_value_name(fd_assign.left_value) !== fd.ast.name) return 1;
		if (carry_is_plain_literal(fd_assign.right_value) !== "1") return 1;
		if (!cond_is_cset_eligible(ifn.condition)) return 1;
		if (cset_flag_is_write_only(ctx, fd.ast.name)) return 1;

		emit_decl_with_flags();
		emit_intervening();
		const flag_reg = status.register_allocations?.get(fd.ast.name);
		if (flag_reg?.startsWith("x") && !fd.n.decl.swap) {
			status.code += `cset ${flag_reg}, ${cc}\n`;
		} else {
			build_declaration_node(fd.ast, status, fd.n.decl.init, fd.n.decl.swap);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			status.code += `cset x0, ${cc}\n`;
			emit_var_store(status, "x0", fd.ast.name, aarch64_size(fd_type));
		}
		return intervening.length + 3;
	}

	// Form B: `if cmp { x += 1 }` — no declare to skip, the target is an
	// existing variable.
	const inc_assign = body[0] as AssignmentNode;
	if (inc_assign.node_type !== "assign") return 1;
	if (inc_assign.operator !== "+=") return 1;
	const inc_lhs = inc_assign.left_value;
	const inc_name = carry_value_name(inc_lhs);
	if (inc_name === null || !inc_lhs) return 1;
	if (carry_is_plain_literal(inc_assign.right_value) !== "1") return 1;
	const inc_type = type_from_value_node(carry_unwrap_grouped(inc_lhs))?.name ?? "int";
	if (is_float_type(inc_type) || !is_scalar_type(inc_type)) return 1;

	emit_decl_with_flags();
	emit_intervening();
	const inc_reg = status.register_allocations?.get(inc_name);
	if (inc_reg?.startsWith("x")) {
		status.code += `cinc ${inc_reg}, ${inc_reg}, ${cc}\n`;
	} else {
		status.code += `cset x0, ${cc}\n`;
		emit_var_load(status, "x1", inc_name, aarch64_size(inc_type));
		status.code += `add x1, x1, x0\n`;
		emit_var_store(status, "x1", inc_name, aarch64_size(inc_type));
	}
	return intervening.length + 2;
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
	// Access-staging pins never cross INTO a nested block build (its
	// condition/bracket emissions sit between the statements) — the
	// label/branch fences catch it textually; this keeps the state scoped.
	pins_taint(status);
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
	// Tranche M (ASM_PLAN_3): loop value numbering — the same deterministic
	// rewrite the seeding planner ran on its own lowering, so the plan's
	// traffic and this body's spine agree. AST splices ride the build and
	// are undone in the finally (the AST is shared and re-lowered per
	// expansion).
	const vn = value_number_loops(nir.body, func.statements, status, true);
	const body_stmts = vn.stmts !== nir.body ? vn.stmts : nir.body;
	// Stage 4 (ASM_PLAN_3): single-use forwarding + write-only flag facts,
	// computed against the SAME plan (register_allocations / nir_site_allocs)
	// the emission below will consult. The pass returns a fresh spine for
	// rewritten statements; publishing THAT list (not nir.body) keeps the
	// shared lowering object untouched. Value-numbering hosts gate its
	// candidates (overlapping splices), and the two use-site maps merge.
	const prepared = prepare_nir_forwarding(body_stmts, status, vn.host_stmts);
	const use_sites = new Map(prepared.use_sites);
	if (vn.use_sites.size > 0) {
		for (const [host, use] of vn.use_sites) {
			const existing = use_sites.get(host);
			if (existing) existing.splices.push(...use.splices);
			else use_sites.set(host, use);
		}
	}
	const old_ctx = status.nir_emit_ctx;
	status.nir_emit_ctx = {
		stmts: prepared.stmts,
		ast: func.statements,
		write_only: prepared.write_only,
		use_sites,
		forward_defs: prepared.forward_defs,
	};
	// A function-like body is a fresh emission scope: prologue patching and
	// inline label rewrites shift absolute code positions — pins from the
	// enclosing scope must not survive into it (ASM_PLAN_3 tranche L).
	pins_taint(status);
	status.forwarded_param_inits = undefined;
	try {
		build_block_node(func, status);
	} finally {
		status.nir_emit_ctx = old_ctx;
		vn.undo();
	}
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
