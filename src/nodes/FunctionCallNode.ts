import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class FunctionCallNode extends BaseNode {
	name: string;
	type: Type;
	params: BaseNode[];

	is_static?: boolean;
	is_func_param?: boolean;
	type_args?: Type[];
	ref_param_indices?: number[];
	mov_param_indices?: number[];
	swap_params?: Map<number, BaseNode>;
	variadic_param_name?: string;
	variadic_param_index?: number;
	/**
	 * Bounds inferred from the call's return contract (`out TYPE: out < X`),
	 * resolved to the caller's receiver path. Populated during checking so that
	 * when this call is used as an argument (e.g. `g.at(g.edge_target(e))`), the
	 * outer call's parameter constraint can verify against the returned value.
	 */
	return_bounds?: {
		upper: string[];
		lower: string[];
		upper_inclusive: string[];
		lower_inclusive: string[];
	};
	/**
	 * A compile-time length derived from the call's return contract
	 * (`out Array<T>: out.length == N`), when N is a literal. Consumed by the
	 * array method-call type transform to set the result type's `.length` so
	 * the build's inline `to_string` paths fire. Stored as a string (the int
	 * literal text), not a ValueNode, to keep this node type-agnostic.
	 */
	inferred_array_length?: string;

	constructor(start: number, name: string, type?: Type, params?: BaseNode[], is_static?: boolean) {
		super("func_call", start);
		this.name = name;
		this.type = type || new Type("");
		this.params = params || [];

		// HACK: For testing
		this.is_static = !!is_static;
	}
}
