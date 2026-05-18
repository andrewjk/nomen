import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class RangeNode extends BaseNode {
	left_value: BaseNode;
	right_value: BaseNode;
	type: Type;

	constructor(start: number, left_value: BaseNode, right_value: BaseNode) {
		super("range", start);
		this.left_value = left_value;
		this.right_value = right_value;
		this.type = new Type("");
	}
}
