import BaseNode from "./BaseNode.ts";
import BranchNode from "./BranchNode.ts";
import type ReturningNode from "./ReturningNode.ts";
import Type from "./Type.ts";

export default class IfElseNode extends BaseNode implements ReturningNode {
	condition: BaseNode;
	return_type: Type;
	if_branch?: BranchNode;
	else_branch?: BranchNode;
	has_return?: boolean;

	constructor(
		start: number,
		condition: BaseNode,
		if_branch?: BranchNode,
		else_branch?: BranchNode,
		return_type?: Type,
	) {
		super("if", start);
		this.condition = condition;
		this.if_branch = if_branch;
		this.else_branch = else_branch;
		// HACK: This is a ReturningNode, just like Function, but they are quite different...
		this.return_type = return_type || new Type("");
		this.has_return = !!return_type;
	}
}
