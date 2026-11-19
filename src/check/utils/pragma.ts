import add_error from "../../add_error.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import GroupedNode from "../../nodes/GroupedNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import PragmaIfNode from "../../nodes/PragmaIfNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import type { MemberHost } from "./comptime.ts";

/**
 * Move one generated/folded member into a type body. Only fields and
 * methods are members; anything else (a raw block, a nested statement) is a
 * compile error — loud, never silently dropped.
 */
export function distribute_member(member: BaseNode, host: MemberHost, status: CheckStatus): void {
	if (member.node_type === "declare") {
		host.fields.push(member as DeclarationNode);
	} else if (member.node_type === "func") {
		host.functions.push(member as FunctionNode);
	} else {
		add_error(status, "only fields and methods can be generated at type-body scope", member.start);
	}
}

/**
 * Fold a type body's `#if`/`#switch` member pragmas: the selected arm's
 * members distribute into the body, the pragma disappears. `#for` member
 * loops stay (they need the struct registry — expanded at the type's own
 * check). Runs from the check() pre-pass for every parsed type AND from
 * the comptime expansions for GENERATED types (whose bodies only exist
 * after the pre-pass ran).
 */
export function fold_member_pragmas(
	host: MemberHost,
	consts: PragmaConsts,
	status: CheckStatus,
): void {
	const pragmas = host.member_pragmas;
	if (!pragmas || pragmas.length === 0) return;
	const kept: BaseNode[] = [];
	for (const pragma of pragmas) {
		fold_pragma_ifs(pragma, consts, status);
		if (pragma.node_type !== "pragma_if") {
			kept.push(pragma);
			continue;
		}
		const inner = select_pragma_branch(pragma as PragmaIfNode, consts, status);
		for (const member of inner) distribute_member(member, host, status);
	}
	host.member_pragmas = kept;
}

/**
 * Compile-time conditionals — `#if META.arch == "c" { ... }` — docs/
 * docs/COMPTIME.md stage 1.
 *
 * The phase contract (R2, applied to the only feature stage 1 has): the
 * pragma is folded BEFORE any checking, splicing the selected arm's
 * statements into the parent list, so the checker and both backends only
 * ever see ordinary AST for code that exists on this target. Dead arms are
 * never parsed-as-checked — they may freely reference declarations that
 * don't exist for the target (that is the point).
 *
 * The condition grammar is deliberately tiny: META.arch / META.platform
 * (comptime strings), string and int literals, arithmetic over ints
 * (`+ - * / %`, division by zero is a compile error), comparisons
 * (`== != < <= > >=` — same-kind operands only), `&& || !`, and
 * parentheses. No user identifiers — that is stage 2's META.info +
 * `#for` (R3/R4), which defers instead of folding.
 */

/** The compile-time target constants a `#if` condition may consult. */
export interface PragmaConsts {
	arch: string;
	platform: string;
}

type ConstValue = string | boolean | number;

type EvalResult =
	| { ok: true; value: ConstValue; start: number }
	| { ok: false; message: string; start: number };

/**
 * Structurally evaluate a `#if` condition against the target constants.
 * Purely structural — there is no name resolution this early in check, so
 * `META.arch` is recognized by SHAPE (a `META` value node accessed as a
 * field), and anything else is an error naming the supported grammar.
 *
 * The grammar (the Comptime II "comptime integers + arithmetic" item):
 * `META.arch` / `META.platform` are comptime strings; int literals are
 * comptime ints; `+ - * / %` fold ints (division by zero is a compile
 * error, never a silent zero); comparisons `== != < <= > >=` produce bools
 * (`==`/`!=` compare same-kind values only); `&& || !` and parentheses
 * compose bools. There are no user identifiers — anything else is an error
 * naming the supported grammar.
 */
export function evaluate_pragma_condition(node: BaseNode, consts: PragmaConsts): EvalResult {
	switch (node.node_type) {
		case "value": {
			const value = (node as ValueNode).value;
			if (value === "true") return { ok: true, value: true, start: node.start };
			if (value === "false") return { ok: true, value: false, start: node.start };
			if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
				return { ok: true, value: value.substring(1, value.length - 1), start: node.start };
			}
			if (/^-?\d+$/.test(value)) {
				return { ok: true, value: parseInt(value, 10), start: node.start };
			}
			return {
				ok: false,
				message:
					"Unsupported #if condition — expected a string/int literal, true, false, META.arch or META.platform",
				start: node.start,
			};
		}
		case "grouped": {
			return evaluate_pragma_condition((node as GroupedNode).value, consts);
		}
		case "access": {
			const access = node as AccessNode;
			if (
				access.target.node_type === "value" &&
				(access.target as ValueNode).value === "META" &&
				access.access.node_type === "access_field"
			) {
				const name = (access.access as AccessFieldNode).name;
				if (name === "arch") return { ok: true, value: consts.arch, start: node.start };
				if (name === "platform") return { ok: true, value: consts.platform, start: node.start };
				return {
					ok: false,
					message: `Unknown META field 'META.${name}' — expected META.arch or META.platform`,
					start: node.start,
				};
			}
			return {
				ok: false,
				message:
					"Unsupported #if condition — only META.arch and META.platform are compile-time values",
				start: node.start,
			};
		}
		case "op": {
			const op = node as OperationNode;
			if (op.op === "!") {
				// Prefix `!` parks its operand in both slots (parse_expression);
				// reading right_value sees it either way.
				const inner = evaluate_pragma_condition(op.right_value, consts);
				if (!inner.ok) return inner;
				const inner_ok = require_boolean(inner, "!");
				if (!inner_ok.ok) return inner_ok;
				return { ok: true, value: !inner.value, start: node.start };
			}
			if (op.op === "u-") {
				// Unary minus on a parenthesized operand (`-(2 + 3)`); a signed
				// literal folds its sign into one token and never reaches here.
				const inner = evaluate_pragma_condition(op.right_value, consts);
				if (!inner.ok) return inner;
				if (typeof inner.value !== "number") {
					return {
						ok: false,
						message: "unary '-' in a #if condition needs an int operand",
						start: node.start,
					};
				}
				return { ok: true, value: -inner.value, start: node.start };
			}
			if (op.op === "+" || op.op === "-" || op.op === "*" || op.op === "/" || op.op === "%") {
				const left = evaluate_pragma_condition(op.left_value, consts);
				if (!left.ok) return left;
				const right = evaluate_pragma_condition(op.right_value, consts);
				if (!right.ok) return right;
				if (typeof left.value !== "number" || typeof right.value !== "number") {
					return {
						ok: false,
						message: `'#if' arithmetic ('${op.op}') needs int operands — comptime strings only compose through == / !=`,
						start: node.start,
					};
				}
				if ((op.op === "/" || op.op === "%") && right.value === 0) {
					return {
						ok: false,
						message: "compile-time division by zero in a #if condition",
						start: node.start,
					};
				}
				switch (op.op) {
					case "+":
						return { ok: true, value: left.value + right.value, start: node.start };
					case "-":
						return { ok: true, value: left.value - right.value, start: node.start };
					case "*":
						return { ok: true, value: left.value * right.value, start: node.start };
					case "/":
						return { ok: true, value: Math.trunc(left.value / right.value), start: node.start };
					default:
						return { ok: true, value: left.value % right.value, start: node.start };
				}
			}
			if (
				op.op === "==" ||
				op.op === "!=" ||
				op.op === "<" ||
				op.op === "<=" ||
				op.op === ">" ||
				op.op === ">="
			) {
				const left = evaluate_pragma_condition(op.left_value, consts);
				if (!left.ok) return left;
				const right = evaluate_pragma_condition(op.right_value, consts);
				if (!right.ok) return right;
				if (typeof left.value !== typeof right.value) {
					return {
						ok: false,
						message: `#if condition compares ${const_type_name(left.value)} with ${const_type_name(right.value)}`,
						start: node.start,
					};
				}
				if (op.op === "==" || op.op === "!=") {
					const equal = left.value === right.value;
					return { ok: true, value: op.op === "==" ? equal : !equal, start: node.start };
				}
				if (typeof left.value !== "number") {
					return {
						ok: false,
						message: `'${op.op}' in a #if condition needs int operands — strings only compare with == / !=`,
						start: node.start,
					};
				}
				const l = left.value as number;
				const r = right.value as number;
				switch (op.op) {
					case "<":
						return { ok: true, value: l < r, start: node.start };
					case "<=":
						return { ok: true, value: l <= r, start: node.start };
					case ">":
						return { ok: true, value: l > r, start: node.start };
					default:
						return { ok: true, value: l >= r, start: node.start };
				}
			}
			if (op.op === "&&" || op.op === "||") {
				const left = evaluate_pragma_condition(op.left_value, consts);
				if (!left.ok) return left;
				const left_ok = require_boolean(left, op.op);
				if (!left_ok.ok) return left_ok;
				const right = evaluate_pragma_condition(op.right_value, consts);
				if (!right.ok) return right;
				const right_ok = require_boolean(right, op.op);
				if (!right_ok.ok) return right_ok;
				return {
					ok: true,
					value: op.op === "&&" ? left.value && right.value : left.value || right.value,
					start: node.start,
				};
			}
			return {
				ok: false,
				message: `Unsupported #if condition operator '${op.op}' — supported: == != < <= > >= && || ! + - * / %`,
				start: node.start,
			};
		}
		default: {
			return {
				ok: false,
				message:
					"Unsupported #if condition — supported: META.arch, META.platform, string/int literals, == != < <= > >= && || ! + - * / % and parentheses",
				start: node.start,
			};
		}
	}
}

function require_boolean(
	result: { ok: true; value: ConstValue; start: number },
	op: string,
): { ok: true } | { ok: false; message: string; start: number } {
	if (typeof result.value === "boolean") return { ok: true };
	return {
		ok: false,
		message: `'${op}' in a #if condition needs boolean operands — compare META values with == / != (e.g. META.arch == "c")`,
		start: result.start,
	};
}

function const_type_name(value: ConstValue): string {
	return typeof value === "string" ? "a string" : typeof value === "number" ? "an int" : "a bool";
}

/**
 * Splice every `#if` pragma out of every statement list, recursively — the
 * compile-time analogue of unwrap_unsafe_blocks (src/check.ts). Runs at the
 * START of check, before any gather/stamp/checking, so every downstream
 * pass sees a flat tree: gather_structs registers target-selected
 * declarations, count_declared_type_names never lets a dead arm's duplicate
 * names trigger live emission-label renames, and no backend ever meets a
 * node type it doesn't know.
 *
 * Selection: the first arm whose condition holds. A condition that fails to
 * evaluate is a compile error and drops the whole pragma (splicing nothing)
 * — downstream still sees sane AST. No matching arm (and no `#else`)
 * removes the pragma entirely, which is the feature: code for other
 * targets disappears without a trace.
 *
 * Stage 5: when the list belongs to a FUNCTION, raw statements that fold
 * away (a raw-only implementation whose every arm missed the target) are
 * counted on `FunctionNode.folded_away_raws` — check_function_node turns
 * that into the empty-implementation error, replacing the tag-era
 * "no aarch64 block found" coverage error. Pragmas NESTED in the body
 * (inside an `if`/`switch` arm) count too: the guard itself still requires
 * an empty statement list, so nested drops can't fire it, but the ownership
 * scan reads the count — a `#destroy` whose release lived in a folded arm
 * keeps the struct owning on this target (see utils/ownership.ts).
 */
export function fold_pragma_ifs(
	node: unknown,
	consts: PragmaConsts,
	status: CheckStatus,
	owner_func?: FunctionNode,
): void {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) fold_pragma_ifs(child, consts, status, owner_func);
		return;
	}
	const any_node = node as Record<string, unknown>;
	if (
		(any_node.node_type === "struct" || any_node.node_type === "trait") &&
		Array.isArray(any_node.member_pragmas)
	) {
		// Stage 3: `#if`/`#switch` INSIDE a struct/trait body — the selected
		// arm's members distribute into the body (fields/methods), the
		// pragma disappears. `#for` member loops stay for the type's own
		// check (expand_struct_member_pragmas — they need the struct
		// registry, which does not exist at fold time).
		fold_member_pragmas(node as unknown as import("./comptime.ts").MemberHost, consts, status);
	}
	if (any_node.node_type === "enum" && Array.isArray(any_node.member_pragmas)) {
		// `#if`/`#switch` INSIDE an enum body selects CASES. The selected
		// arm's `case` declarations append to the enum's list; a name
		// template cannot resolve without a `#for` binding, so it is an
		// error here.
		const enum_node = node as unknown as {
			cases: { name: string; params: unknown[] }[];
			member_pragmas: BaseNode[];
		};
		const kept: BaseNode[] = [];
		for (const pragma of enum_node.member_pragmas) {
			if (pragma.node_type !== "pragma_if") {
				kept.push(pragma);
				continue;
			}
			const inner = select_pragma_branch(pragma as PragmaIfNode, consts, status);
			for (const member of inner) {
				if (member.node_type !== "enum_case_decl") {
					add_error(status, "only cases can be generated at enum-body scope", member.start);
					continue;
				}
				const decl = member as import("../../nodes/EnumCaseDeclNode.ts").default;
				if (decl.comptime_name !== undefined) {
					add_error(
						status,
						"a #if-selected case needs a literal name — name templates need a #for binding",
						member.start,
					);
					continue;
				}
				enum_node.cases.push({ name: decl.name, params: decl.params });
			}
		}
		enum_node.member_pragmas = kept;
	}
	if (Array.isArray(any_node.statements)) {
		const list = any_node.statements as BaseNode[];
		// A function's own statement list is the OWNER boundary: nested
		// functions are their own owner, and every other list nested in the
		// body (if/switch arms, pragma arm blocks) keeps the enclosing
		// function as the owner — the folded-raw count is per function.
		const is_func_list = any_node.node_type === "func";
		const list_owner = is_func_list ? (node as FunctionNode) : owner_func;
		for (let i = list.length - 1; i >= 0; i--) {
			const child = list[i] as BaseNode | undefined;
			// Recurse first so nested statement lists (pragma arms, function
			// bodies, struct bodies, inner blocks) are already folded when we
			// splice — the spliced-in statements are fold-free.
			fold_pragma_ifs(child, consts, status, list_owner);
			if (!child || typeof child !== "object" || child.node_type !== "pragma_if") continue;
			const inner = select_pragma_branch(child as PragmaIfNode, consts, status);
			if (list_owner) {
				const dropped = count_dropped_raws(child as PragmaIfNode, consts);
				if (dropped > 0) {
					list_owner.folded_away_raws = (list_owner.folded_away_raws ?? 0) + dropped;
				}
			}
			list.splice(i, 1, ...inner);
		}
	}
	for (const key of Object.keys(node)) {
		if (key === "parent" || key === "scope" || key === "statements") continue;
		const value = any_node[key];
		if (value && typeof value === "object") fold_pragma_ifs(value, consts, status, owner_func);
	}
}

/**
 * How many raw statements the pragma's unselected arms would have spliced —
 * the raw-only-implementation coverage signal. Evaluator failures already
 * reported through select_pragma_branch are counted conservatively (a block
 * that vanished is a block that vanished).
 */
function count_dropped_raws(pragma: PragmaIfNode, consts: PragmaConsts): number {
	let dropped = 0;
	for (const branch of pragma.branches) {
		if (!branch.condition) continue;
		const result = evaluate_pragma_condition(branch.condition, consts);
		if (result.ok && typeof result.value === "boolean" && result.value) continue;
		for (const stmt of branch.block.statements ?? []) {
			if (stmt.node_type === "raw") dropped++;
		}
	}
	return dropped;
}

/** Pick the first matching arm of a folded pragma and return its statements. */
function select_pragma_branch(
	pragma: PragmaIfNode,
	consts: PragmaConsts,
	status: CheckStatus,
): BaseNode[] {
	for (const branch of pragma.branches) {
		if (branch.condition) {
			const result = evaluate_pragma_condition(branch.condition, consts);
			if (!result.ok) {
				add_error(status, result.message, result.start);
				return [];
			}
			// A bare META value is a string — conditions must be boolean.
			// (Comptime strings only compose through == / != for now; name
			// generation makes them first-class in stage 2, R6.)
			if (typeof result.value !== "boolean") {
				add_error(
					status,
					'#if condition must be a bool — compare META values with == / != (e.g. META.arch == "c")',
					result.start,
				);
				return [];
			}
			if (!result.value) continue;
		}
		return branch.block.statements ?? [];
	}
	return [];
}
