import BaseNode from "./BaseNode.ts";
import BranchNode from "./BranchNode.ts";
import type ReturningNode from "./ReturningNode.ts";
import Type from "./Type.ts";

export default class SwitchNode extends BaseNode implements ReturningNode {
	cases: { condition: BaseNode; branch: BranchNode }[];
	else_branch?: BranchNode;
	return_type: Type;
	has_return?: boolean;

	constructor(
		start: number,
		cases: { condition: BaseNode; branch: BranchNode }[] = [],
		else_branch?: BranchNode,
		return_type?: Type,
	) {
		super("switch", start);
		this.cases = cases;
		this.else_branch = else_branch;
		this.return_type = return_type || new Type("");
		this.has_return = !!return_type;
	}
}
