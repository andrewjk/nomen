import BaseNode from "./BaseNode.ts";
import ParameterNode from "./ParameterNode.ts";
import Type from "./Type.ts";

export default class DeclarationNode extends BaseNode {
	visibility: "pub" | "private";
	declaration: "const" | "var" | "mov";
	name: string;
	type: Type;
	value?: BaseNode;
	constraint?: BaseNode;
	name_start?: number;
	type_start?: number;
	func_params?: ParameterNode[];
	func_return_type?: Type;
	scope?: BaseNode;
	/** Optional swap replacement for `var X b = mov obj.field swap <expr>`: the
	 *  expression stored back into the moved-out field to revalidate it. */
	swap?: BaseNode;

	constructor(
		start: number,
		visibility: "pub" | "private",
		declaration: "const" | "var" | "mov",
		name: string,
		type?: Type,
		value?: BaseNode,
	) {
		super("declare", start);
		this.visibility = visibility;
		this.declaration = declaration;
		this.name = name;
		this.type = type || new Type("");
		this.value = value;
	}
}
