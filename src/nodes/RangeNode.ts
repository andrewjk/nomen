import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class RangeNode extends BaseNode {
	left_value: BaseNode;
	right_value: BaseNode;
	inclusive: boolean;
	type: Type;

	constructor(start: number, left_value: BaseNode, right_value: BaseNode, inclusive: boolean) {
		super("range", start);
		this.left_value = left_value;
		this.right_value = right_value;
		this.inclusive = inclusive;
		this.type = new Type("");
	}
}
