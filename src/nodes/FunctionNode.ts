import BaseNode from "./BaseNode.ts";
import type BlockNode from "./BlockNode.ts";
import IfElseNode from "./IfElseNode.ts";
import ParameterNode from "./ParameterNode.ts";
import type ReturningNode from "./ReturningNode.ts";
import Type from "./Type.ts";

function branch_has_return(statements: BaseNode[]): boolean {
	for (const s of statements) {
		if (s.node_type === "return") return true;
		if (s.node_type === "if") {
			const if_else = s as IfElseNode;
			const if_ret = if_else.if_branch && branch_has_return(if_else.if_branch.statements);
			const else_ret = if_else.else_branch && branch_has_return(if_else.else_branch.statements);
			if (if_ret && else_ret) return true;
		}
	}
	return false;
}

export default class FunctionNode extends BaseNode implements BlockNode, ReturningNode {
	visibility: "pub" | "private";
	name: string;
	return_type: Type;
	params: ParameterNode[];
	statements: BaseNode[];
	has_body?: boolean;
	has_return?: boolean;
	is_arrow_body?: boolean;
	return_type_start?: number;
	is_static?: boolean;
	is_generic?: boolean;
	checked?: boolean;
	is_inline?: boolean;
	/** True when this function is defined in the appended System library source. */
	is_library?: boolean;
	/**
	 * True for a `mov out T` return: the method transfers ownership of the
	 * returned value to the caller (which must then free it), rather than
	 * lending a borrow. The canonical example is `List.pop`. Symmetric to a
	 * `mov T` parameter (ownership in), this is ownership out.
	 */
	returns_mov?: boolean;
	/**
	 * True for a string-returning function whose return expressions hand
	 * back a BORROW (a parameter pass-through, a borrow-initialized local,
	 * a literal, a field, or a borrow accessor like `.at`) rather than a
	 * fresh heap allocation. On backends that pass borrows through raw
	 * (aarch64), the caller must NOT free such a result; the C backend
	 * normalizes at the return site (strdup) instead, so every string
	 * return there is owned regardless. Stamped once by the shared
	 * string-return analysis (build_common/string_return_analysis.ts).
	 */
	returns_string_borrow?: boolean;
	type_params: string[] = [];
	scope?: BaseNode;
	/**
	 * Unique backend label for a function declared NESTED inside another
	 * function body. Call resolution is parent-scoped during checking (each
	 * body's cloned function table), but both backends hoist nested funcs to
	 * file scope — a bare name would collide across siblings sharing it, or
	 * across monomorphized clones of the same generic parent. Assigned by the
	 * checker's block gather as `<parent>_<name>` ( uniquified against every
	 * other function emission name); `name` stays the source name so
	 * resolution keeps working. Undefined for top-level functions (they emit
	 * under their own name).
	 */
	label_name?: string;
	/**
	 * Optional contract on the return value, parsed from `out TYPE: constraint`.
	 * The placeholder `out` refers to the return value; other identifiers refer
	 * to the function's parameters. Used by check_function_call to propagate
	 * bounds to the caller's LHS variable.
	 */
	return_constraint?: BaseNode;

	constructor(
		start: number,
		visibility: "pub" | "private",
		name: string,
		return_type: Type,
		params?: ParameterNode[],
		statements?: BaseNode[],
	) {
		super("func", start);
		this.visibility = visibility;
		this.name = name;
		this.return_type = return_type || new Type("");
		this.params = params || [];
		this.is_static = !params || !params[0]?.is_self_param;
		this.statements = statements || [];
		if (statements) {
			this.has_body = true;
			if (branch_has_return(statements)) {
				this.has_return = true;
			}
		}
	}
}
