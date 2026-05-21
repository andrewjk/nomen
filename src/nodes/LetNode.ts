import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class LetNode extends BaseNode {
	value: BaseNode;
	type: Type;

	constructor(start: number, value: BaseNode, type?: Type) {
		super("let", start);
		this.value = value;
		this.type = type || new Type("");
	}
}
