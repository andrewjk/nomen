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
	return_type_start?: number;
	is_static?: boolean;
	is_generic?: boolean;
	checked?: boolean;
	is_inline?: boolean;
	type_params: string[] = [];
	scope?: BaseNode;
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
