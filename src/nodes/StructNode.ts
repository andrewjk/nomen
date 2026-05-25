import built_in_types from "../built_in_types.ts";
import BaseNode from "./BaseNode.ts";
import DeclarationNode from "./DeclarationNode.ts";
import FunctionNode from "./FunctionNode.ts";

export default class StructNode extends BaseNode {
	visibility: "inherit" | "pub" | "mod" | "priv";
	name: string;
	traits: string[];
	fields: DeclarationNode[];
	functions: FunctionNode[];
	destroy_body?: BaseNode;
	type_params: string[];
	privates_visible: boolean;
	is_simple_type: boolean;
	is_generic?: boolean;

	constructor(
		start: number,
		visibility: "inherit" | "pub" | "mod" | "priv",
		name: string,
		traits?: string[],
		fields?: DeclarationNode[],
		functions?: FunctionNode[],
	) {
		super("struct", start);
		this.visibility = visibility;
		this.name = name;
		this.traits = traits || [];
		this.fields = fields || [];
		this.functions = functions || [];
		this.type_params = [];

		this.privates_visible = false;
		// TODO: String shouldn't be a simple type in all circumstances (e.g. if it is growable)
		this.is_simple_type = built_in_types.includes(name);
	}
}
