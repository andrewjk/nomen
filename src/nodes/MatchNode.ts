import BaseNode from "./BaseNode.ts";
import BranchNode from "./BranchNode.ts";
import type ReturningNode from "./ReturningNode.ts";
import Type from "./Type.ts";

export default class MatchNode extends BaseNode implements ReturningNode {
	value: BaseNode;
	cases: { match_value: BaseNode; branch: BranchNode; params?: string[] }[];
	else_branch?: BranchNode;
	return_type: Type;
	has_return?: boolean;
	value_type?: string;

	constructor(
		start: number,
		value: BaseNode,
		cases: { match_value: BaseNode; branch: BranchNode; params?: string[] }[] = [],
		else_branch?: BranchNode,
		return_type?: Type,
	) {
		super("match", start);
		this.value = value;
		this.cases = cases;
		this.else_branch = else_branch;
		this.return_type = return_type || new Type("");
		this.has_return = !!return_type;
	}
}
