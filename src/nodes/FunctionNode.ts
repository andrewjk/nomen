import BaseNode from "./BaseNode.ts";
import type BlockNode from "./BlockNode.ts";
import ParameterNode from "./ParameterNode.ts";
import type ReturningNode from "./ReturningNode.ts";
import Type from "./Type.ts";

export default class FunctionNode extends BaseNode implements BlockNode, ReturningNode {
	visibility: "inherit" | "pub" | "mod" | "priv";
	name: string;
	return_type: Type;
	params: ParameterNode[];
	statements: BaseNode[];
	has_body?: boolean;
	// TODO: Check all branches
	has_return?: boolean;
	return_type_start?: number;
	is_static?: boolean;

	constructor(
		start: number,
		visibility: "inherit" | "pub" | "mod" | "priv",
		name: string,
		return_type: Type,
		params?: ParameterNode[],
		statements?: BaseNode[],
	) {
		super("func", start);
		this.visibility = visibility;
		this.name = name;
		this.return_type = return_type || new Type("");
		this.params = params || [];
		this.is_static = !params || !params[0]?.is_self_param;
		this.statements = statements || [];
		if (statements) {
			this.has_body = true;
			if (statements.find((s) => s.node_type === "return")) {
				this.has_return = true;
			}
		}
	}
}
