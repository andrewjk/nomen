import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class ReturnNode extends BaseNode {
	value: BaseNode | null;
	type: Type;

	from_inline?: boolean;

	constructor(start: number, value: BaseNode | null, type?: Type) {
		super("return", start);
		this.value = value;
		this.type = type || new Type("");
	}
}
