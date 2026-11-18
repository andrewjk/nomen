import BaseNode from "./BaseNode.ts";
import DeclarationNode from "./DeclarationNode.ts";
import FunctionNode from "./FunctionNode.ts";

export default class TraitNode extends BaseNode {
	visibility: "pub" | "private" | "internal";
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
	/**
	 * Compile-time pragmas parsed INSIDE the body — `#if`/`#switch` target
	 * selection and `#for` reflection loops over members. Folds/expands at
	 * the trait's own check, exactly like a struct's (see StructNode).
	 */
	member_pragmas?: BaseNode[];
	/** A comptime name splice for the trait's own name (`trait #field.name`,
	 *  stage-6 generation) — see StructNode.comptime_name. */
	comptime_name?: string;
	/** Stamped by a comptime expansion on a `$`-generated trait — see
	 *  StructNode.is_comptime_generated. */
	is_comptime_generated?: boolean;

	constructor(
		start: number,
		visibility: "pub" | "private" | "internal",
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
