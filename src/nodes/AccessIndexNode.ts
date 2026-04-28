import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class AccessIndexNode extends BaseNode {
	index: BaseNode;
	type: Type;
	name: string;

	constructor(start: number, index: BaseNode, type?: Type) {
		super("access_index", start);
		this.index = index;
		this.type = type || new Type("");
		// HACK: This is never used
		this.name = "";
	}
}
