import built_in_types from "../built_in_types.ts";
import BaseNode from "./BaseNode.ts";
import DeclarationNode from "./DeclarationNode.ts";
import FunctionNode from "./FunctionNode.ts";
import Type from "./Type.ts";

export default class StructNode extends BaseNode {
	visibility: "pub" | "private";
	name: string;
	traits: string[];
	/**
	 * Type arguments supplied for each trait conformance, parallel to
	 * `traits`. `trait_args[i]` holds the args for `traits[i]`
	 * (e.g. `struct Users: Viewable<User>` → trait_args[0] = [Type(User)];
	 * `undefined` when the trait is non-generic or conformance omits args).
	 * Vtable dispatch keys on the trait name, so args don't affect layout —
	 * they're validated for arity against the trait's `type_params`.
	 */
	trait_args: (Type[] | undefined)[];
	fields: DeclarationNode[];
	functions: FunctionNode[];
	type_params: string[];
	is_simple_type: boolean;
	is_generic?: boolean;
	is_class?: boolean;
	scope?: BaseNode;
	source_type_args?: Type[];
	/** True when this struct is defined in the appended System library source. */
	is_library?: boolean;

	constructor(
		start: number,
		visibility: "pub" | "private",
		name: string,
		traits?: string[],
		fields?: DeclarationNode[],
		functions?: FunctionNode[],
	) {
		super("struct", start);
		this.visibility = visibility;
		this.name = name;
		this.traits = traits || [];
		this.trait_args = (traits || []).map(() => undefined);
		this.fields = fields || [];
		this.functions = functions || [];
		this.type_params = [];
		// TODO: String shouldn't be a simple type in all circumstances (e.g. if it is growable)
		this.is_simple_type = built_in_types.includes(name);
	}
}
