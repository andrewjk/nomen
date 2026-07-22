import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class AccessFieldNode extends BaseNode {
	name: string;
	type: Type;
	/**
	 * Marker for destructuring bindings (`var [a, b] = expr`): the access is
	 * a placeholder whose target field is resolved at check time from the
	 * right-hand side's type. For positional bindings (bare names) the
	 * `name` is also the binding name, so a struct target can access the
	 * field of the same name. `destructure_index` is the positional index.
	 */
	is_destructure?: boolean;
	destructure_index?: number;
	/** `[field = new_name]` rename form — struct/class targets only. */
	is_destructure_rename?: boolean;

	constructor(start: number, name: string, type?: Type) {
		super("access_field", start);
		this.name = name;
		this.type = type || new Type("");
	}
}
