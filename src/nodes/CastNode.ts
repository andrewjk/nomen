import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class CastNode extends BaseNode {
	value: BaseNode;
	target_type: Type;
	type: Type;
	operator_func?: { struct_name: string; func_name: string };

	constructor(start: number, value: BaseNode, target_type: Type) {
		super("cast", start);
		this.value = value;
		this.target_type = target_type;
		this.type = target_type;
	}
}
