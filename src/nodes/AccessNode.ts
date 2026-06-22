import AccessFieldNode from "./AccessFieldNode.ts";
import AccessFunctionCallNode from "./AccessFunctionCallNode.ts";
import BaseNode from "./BaseNode.ts";

export default class AccessNode extends BaseNode {
	target: BaseNode;
	access: AccessFieldNode | AccessFunctionCallNode;

	constructor(start: number, target: BaseNode, access: AccessFieldNode | AccessFunctionCallNode) {
		super("access", start);
		this.target = target;
		this.access = access;
	}
}
