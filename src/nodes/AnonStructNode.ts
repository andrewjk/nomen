import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class AnonStructNode extends BaseNode {
	fields: { name: string; value: BaseNode }[];
	type?: Type;

	constructor(start: number, fields: { name: string; value: BaseNode }[]) {
		super("anon_struct", start);
		this.fields = fields;
	}
}
