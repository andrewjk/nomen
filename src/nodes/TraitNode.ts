import BaseNode from "./BaseNode.ts";
import DeclarationNode from "./DeclarationNode.ts";
import FunctionNode from "./FunctionNode.ts";

export default class TraitNode extends BaseNode {
	visibility: "pub" | "private";
	name: string;
	fields: DeclarationNode[];
	functions: FunctionNode[];

	constructor(
		start: number,
		visibility: "pub" | "private",
		name: string,
		fields?: DeclarationNode[],
		functions?: FunctionNode[],
	) {
		super("trait", start);
		this.visibility = visibility;
		this.name = name;
		this.fields = fields || [];
		this.functions = functions || [];
	}
}
