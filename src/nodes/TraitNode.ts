import BaseNode from "./BaseNode.ts";
import DeclarationNode from "./DeclarationNode.ts";
import FunctionNode from "./FunctionNode.ts";

export default class TraitNode extends BaseNode {
	visibility: "pub" | "private";
	name: string;
	fields: DeclarationNode[];
	functions: FunctionNode[];
	/** True when this trait is defined in the appended System library source. */
	is_library?: boolean;
	/**
	 * Generic trait type parameters, e.g. `trait Viewable<T>` → ["T"].
	 * Trait methods/fields may reference these; conforming structs supply
	 * concrete type arguments (`struct Users: Viewable<User>`).
	 */
	type_params: string[];

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
		this.type_params = [];
	}
}
