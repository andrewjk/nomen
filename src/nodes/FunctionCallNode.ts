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
	return_bounds?: { upper: string[]; lower: string[] };

	constructor(start: number, name: string, type?: Type, params?: BaseNode[], is_static?: boolean) {
		super("func_call", start);
		this.name = name;
		this.type = type || new Type("");
		this.params = params || [];

		// HACK: For testing
		this.is_static = !!is_static;
	}
}
