import type AccessFieldNode from "../nodes/AccessFieldNode.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type AccessNode from "../nodes/AccessNode.ts";
import type AssignmentNode from "../nodes/AssignmentNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type CastNode from "../nodes/CastNode.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type ForLoopNode from "../nodes/ForLoopNode.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type GroupedNode from "../nodes/GroupedNode.ts";
import type IfElseNode from "../nodes/IfElseNode.ts";
import type LetNode from "../nodes/LetNode.ts";
import type MatchNode from "../nodes/MatchNode.ts";
import type OperationNode from "../nodes/OperationNode.ts";
import type ReturnNode from "../nodes/ReturnNode.ts";
import type SpawnNode from "../nodes/SpawnNode.ts";
import type SwitchNode from "../nodes/SwitchNode.ts";
import type WhileLoopNode from "../nodes/WhileLoopNode.ts";
import type {
	NirCallFacts,
	NirDeclareInfo,
	NirExpr,
	NirFunction,
	NirPathStep,
	NirStmt,
} from "./nir.ts";

/**
 * AST → NIR lowering (see nir.ts for the contract). One direction, one
 * place: every mapping decision lives here so analyses downstream never
 * re-guess AST shapes. Unmodeled constructs become `other` IR variants and
 * are recorded into `unknown_kinds`, keeping blind spots loud instead of
 * silent.
 */

/** Mirrors the identifier rules the historical scans used (func_flow.ts). */
export function is_identifier_like(val: unknown): val is string {
	return (
		typeof val === "string" &&
		val.length > 0 &&
		!/^(\+|-)?\d+(\.\d+)?$/.test(val) &&
		!val.startsWith('"') &&
		!val.startsWith("'") &&
		val !== "true" &&
		val !== "false" &&
		val !== "null" &&
		val !== "self" &&
		val !== "as"
	);
}

interface LowerCtx {
	coverage: Set<string>;
}

function record_unknown(ctx: LowerCtx, node: BaseNode | null | undefined): void {
	if (node && typeof (node as any).node_type === "string")
		ctx.coverage.add((node as any).node_type);
}

/** Lower a STATEMENT LIST (branch bodies, loop bodies, the fn body). */
function block(ctx: LowerCtx, stmts: BaseNode[] | null | undefined): NirStmt[] {
	const out: NirStmt[] = [];
	if (!stmts) return out;
	for (const s of stmts) out.push(stmt(ctx, s));
	return out;
}

function stmt(ctx: LowerCtx, n: BaseNode): NirStmt {
	switch (n.node_type) {
		case "declare":
			return declare_stmt(ctx, n as DeclarationNode);
		case "assign":
			return assign_stmt(ctx, n as AssignmentNode);
		case "return": {
			const ret = n as ReturnNode;
			return { kind: "return", node: n, value: ret.value ? expr(ctx, ret.value) : null };
		}
		case "break":
			return { kind: "break", node: n };
		case "continue":
			return { kind: "continue", node: n };
		case "panic":
		case "todo":
			return { kind: "exit", node: n, message: ((n as any).message as string) ?? null };
		case "if": {
			const iff = n as IfElseNode;
			return {
				kind: "if",
				node: n,
				cond: expr(ctx, iff.condition),
				then_branch: block(ctx, iff.if_branch?.statements),
				else_branch: block(ctx, iff.else_branch?.statements),
			};
		}
		case "while": {
			const wh = n as WhileLoopNode;
			return {
				kind: "while",
				node: n,
				cond: expr(ctx, wh.condition),
				body: block(ctx, wh.statements),
				update: wh.update ? stmt(ctx, wh.update) : null,
			};
		}
		case "for": {
			const f = n as ForLoopNode;
			return {
				kind: "for",
				node: n,
				item_name: String(f.item?.value ?? ""),
				list: f.list ? expr(ctx, f.list) : null,
				body: block(ctx, f.statements),
				update: f.update ? stmt(ctx, f.update) : null,
			};
		}
		case "switch":
		case "match": {
			if (n.node_type === "switch") {
				const sw = n as SwitchNode;
				return {
					kind: "switch_match",
					node: n,
					scrutinee: null,
					arms: sw.cases.map((c) => ({
						condition: c.condition ? expr(ctx, c.condition) : null,
						branch: block(ctx, c.branch?.statements),
					})),
					otherwise: sw.else_branch ? block(ctx, sw.else_branch.statements) : null,
				};
			}
			const m = n as MatchNode;
			return {
				kind: "switch_match",
				node: n,
				scrutinee: m.value ? expr(ctx, m.value) : null,
				arms: m.cases.map((c) => ({
					condition: c.match_value ? expr(ctx, c.match_value) : null,
					branch: block(ctx, c.branch?.statements),
				})),
				otherwise: m.else_branch ? block(ctx, m.else_branch.statements) : null,
			};
		}
		case "let": {
			// Arrow arms (`case X -> target = value` in match/switch/if) parse
			// the assignment as a LET wrapping an assign EXPRESSION; lower it
			// as the assign KIND so the arm's traffic is visible and the
			// function stays NIR-eligible. Any other let rides the eval path.
			const inner = (n as LetNode).value;
			if (inner && inner.node_type === "assign") {
				return assign_stmt(ctx, inner as AssignmentNode);
			}
			return { kind: "eval", node: n, expr: expr(ctx, n) };
		}
		case "spawn": {
			const sp = n as SpawnNode;
			return { kind: "spawn", node: n, call: expr(ctx, sp.call) };
		}
		case "async_block":
			return { kind: "async_block", node: n, body: block(ctx, (n as any).statements) };
		case "raw":
			return { kind: "raw", node: n, code: String((n as any).value ?? "") };
		case "func": {
			const f = n as FunctionNode;
			return {
				kind: "nested_func",
				node: n,
				name: f.name,
				label_name: f.label_name,
				params: (f.params ?? []).map((p) => ({ name: p.name, type: p.type })),
				// Inline lowering keeps the enclosing analysis conservative in
				// exactly the way the historical scans were: nested declarations
				// still shadow-count against this function, nested calls'
				// ref-arguments still exclude outer names.
				body: f.has_body === false ? [] : block(ctx, f.statements),
			};
		}
		case "struct":
		case "class":
		case "trait":
		case "enum":
		case "bitset":
		case "extend": {
			// Type declarations carry no executable statements: the block loop
			// skips them before dispatch (struct/trait/enum/bitset) or they emit
			// nothing (class/extend — `extend` bodies were merged into the
			// target struct during check). They lower to `opaque` WITHOUT
			// recording into `unknown_kinds`: their IR entries are never
			// consumed by the emitter, so they must not force the fallback.
			// Bodies are deliberately not descended — matching the historical
			// scans and keeping promotion inputs byte-stable.
			return { kind: "opaque", node: n };
		}
		default: {
			// Expression-shaped statements (bare calls, non-assign lets) carry
			// traffic and lower to eval; anything genuinely unmapped surfaces
			// as opaque.
			if (is_expr_node(n)) return { kind: "eval", node: n, expr: expr(ctx, n) };
			record_unknown(ctx, n);
			return { kind: "opaque", node: n };
		}
	}
}

/** Lower an AssignmentNode — statement-level, or let-wrapped (arrow arms). */
function assign_stmt(ctx: LowerCtx, a: AssignmentNode): NirStmt {
	return {
		kind: "assign",
		node: a,
		target: expr(ctx, a.left_value),
		rhs: expr(ctx, a.right_value),
		operator: (a.operator as string | undefined) ?? null,
		swap: a.swap ? expr(ctx, a.swap) : null,
	};
}

function declare_stmt(ctx: LowerCtx, d: DeclarationNode): NirStmt {
	const t = d.type;
	const info: NirDeclareInfo = {
		name: d.name,
		type: t,
		modifiers: {
			is_array: t?.is_array,
			is_view: t?.is_view,
			is_ref: t?.is_ref,
			is_nullable: t?.is_nullable,
		},
		init: d.value ? expr(ctx, d.value) : null,
		swap: d.swap ? expr(ctx, d.swap) : null,
		node: d,
	};
	return { kind: "declare", node: d, decl: info };
}

function is_expr_node(n: BaseNode): boolean {
	switch (n.node_type) {
		case "value":
		case "op":
		case "grouped":
		case "cast":
		case "let":
		case "access":
		case "access_field":
		case "access_func":
		case "func_call":
		case "range":
		case "array":
			return true;
		default:
			return false;
	}
}

function call_facts(
	ctx: LowerCtx,
	call: FunctionCallNode | AccessFunctionCallNode,
): { args: NirExpr[]; facts: NirCallFacts } {
	const args = (call.params ?? []).map((p) => expr(ctx, p));
	const swaps: NirExpr[] = [];
	const swap_map = (call as AccessFunctionCallNode).swap_params;
	if (swap_map instanceof Map) {
		for (const v of swap_map.values()) swaps.push(expr(ctx, v));
	}
	return {
		args,
		facts: {
			args,
			ref_arg_indices: [...((call.ref_param_indices as number[]) ?? [])],
			swap_exprs: swaps,
		},
	};
}

function expr(ctx: LowerCtx, n: BaseNode | null | undefined): NirExpr {
	if (!n || typeof n !== "object") {
		return { kind: "leaf", node: (n ?? ({} as BaseNode)) as BaseNode, name: null };
	}
	switch (n.node_type) {
		case "value": {
			const val = (n as any).value;
			return { kind: "leaf", node: n, name: is_identifier_like(val) ? val : null };
		}
		case "op": {
			const op = n as OperationNode;
			return {
				kind: "binary",
				node: n,
				left: expr(ctx, op.left_value),
				right: expr(ctx, op.right_value),
			};
		}
		case "range":
			return {
				kind: "binary",
				node: n,
				left: expr(ctx, (n as any).left_value),
				right: expr(ctx, (n as any).right_value),
			};
		case "grouped":
		case "cast":
		case "let": {
			const inner =
				n.node_type === "cast"
					? (n as CastNode).value
					: n.node_type === "grouped"
						? (n as GroupedNode).value
						: (n as LetNode).value;
			return { kind: "wrap", node: n, inner: inner ? expr(ctx, inner) : null };
		}
		case "array":
			return {
				kind: "call",
				node: n,
				callee: "[array literal]",
				facts: {
					args: ((n as any).values ?? []).map((v: BaseNode) => expr(ctx, v)),
					ref_arg_indices: [],
					swap_exprs: [],
				},
			};
		case "func_call": {
			const { args, facts } = call_facts(ctx, n as FunctionCallNode);
			return {
				kind: "call",
				node: n,
				callee: (n as FunctionCallNode).name,
				facts: { ...facts, args },
			};
		}
		case "access_func": {
			const { args, facts } = call_facts(ctx, n as AccessFunctionCallNode);
			return {
				kind: "call",
				node: n,
				callee: (n as AccessFunctionCallNode).name,
				facts: { ...facts, args },
			};
		}
		case "access": {
			const acc = n as AccessNode;
			const step_name = acc.access?.name ?? "";
			if (acc.access && acc.access.node_type === "access_func") {
				const { args, facts } = call_facts(ctx, acc.access as AccessFunctionCallNode);
				return {
					kind: "method_call",
					node: n,
					receiver: expr(ctx, acc.target),
					name: acc.access.name,
					facts: { ...facts, args },
				};
			}
			const steps: NirPathStep[] = [{ name: step_name, node: acc.access }];
			return { kind: "path", node: n, receiver: expr(ctx, acc.target), steps };
		}
		case "if":
		case "switch":
		case "match": {
			// Control flow in VALUE position (`var k = match len { … }`,
			// `return if c { a } else { b }`). The emission side routes the
			// ORIGINAL node through build_node, whose join-slot machinery (the
			// same builders the AST walk used) stores each arm's value into
			// `status.return_assign`; the arms ride the IR for liveness.
			if (n.node_type === "if") {
				const iff = n as IfElseNode;
				return {
					kind: "flow",
					node: n,
					scrutinee: null,
					arms: [
						{
							condition: iff.condition ? expr(ctx, iff.condition) : null,
							branch: block(ctx, iff.if_branch?.statements),
						},
					],
					otherwise: iff.else_branch ? block(ctx, iff.else_branch.statements) : null,
				};
			}
			if (n.node_type === "switch") {
				const sw = n as SwitchNode;
				return {
					kind: "flow",
					node: n,
					scrutinee: null,
					arms: sw.cases.map((c) => ({
						condition: c.condition ? expr(ctx, c.condition) : null,
						branch: block(ctx, c.branch?.statements),
					})),
					otherwise: sw.else_branch ? block(ctx, sw.else_branch.statements) : null,
				};
			}
			const m = n as MatchNode;
			return {
				kind: "flow",
				node: n,
				scrutinee: m.value ? expr(ctx, m.value) : null,
				arms: m.cases.map((c) => ({
					condition: c.match_value ? expr(ctx, c.match_value) : null,
					branch: block(ctx, c.branch?.statements),
				})),
				otherwise: m.else_branch ? block(ctx, m.else_branch.statements) : null,
			};
		}
		case "spawn": {
			// `var t = spawn f(x)` — a task handle is a VALUE. The wrapped call
			// rides whole (its facts carry the arg reads for liveness).
			return { kind: "spawn", node: n, call: expr(ctx, (n as SpawnNode).call) };
		}
		case "func": {
			// A function used as a VALUE: `var func (int) handler { … }`
			// declares a function-typed variable whose value is the
			// FunctionNode. The seam routes build_node to it — which builds
			// the function (label + body) exactly as the AST walk did. A
			// function reference reads no storage, so it carries no name.
			return { kind: "leaf", node: n, name: null };
		}
		default: {
			// Field-read chains and destructures reachable in value position.
			if ((n as any).node_type === "access_field") {
				return {
					kind: "path",
					node: n,
					receiver: { kind: "leaf", node: n, name: null },
					steps: [{ name: (n as AccessFieldNode).name, node: n }],
				};
			}
			record_unknown(ctx, n);
			return { kind: "other", node: n };
		}
	}
}

/**
 * Lower a checked function to NIR. `unknown_kinds` reports AST node types
 * that had no NIR mapping and surfaced as `other`/`opaque` variants — tests
 * assert this stays EMPTY over real programs.
 */
export function lower_function(func: {
	name?: string;
	label_name?: string;
	params: { name: string; type: any; is_variadic?: boolean }[];
	statements: BaseNode[];
}): NirFunction {
	const coverage = new Set<string>();
	const ctx: LowerCtx = { coverage };
	const body = block(ctx, func.statements);
	return {
		name: func.name ?? "",
		label_name: func.label_name,
		params: (func.params ?? []).map((p) => ({
			name: p.name,
			type: p.type,
			is_variadic: p.is_variadic,
		})),
		body,
		unknown_kinds: coverage,
	};
}
