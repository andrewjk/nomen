import BaseNode from "./BaseNode.ts";
import type BlockNode from "./BlockNode.ts";

export default class WhileLoopNode extends BaseNode implements BlockNode {
	condition: BaseNode;
	update?: BaseNode;
	statements: BaseNode[];

	constructor(start: number, condition: BaseNode, statements?: BaseNode[], update?: BaseNode) {
		super("while", start);
		this.condition = condition;
		this.statements = statements || [];
		this.update = update;
	}
}
