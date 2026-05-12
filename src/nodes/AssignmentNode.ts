import BaseNode from "./BaseNode.ts";

export default class AssignmentNode extends BaseNode {
	left_value: BaseNode;
	right_value: BaseNode;
	operator?: string;

	constructor(start: number, left_value: BaseNode, right_value: BaseNode, operator?: string) {
		super("assign", start);
		this.left_value = left_value;
		this.right_value = right_value;
		this.operator = operator;
	}
}
