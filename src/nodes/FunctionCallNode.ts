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

	constructor(start: number, name: string, type?: Type, params?: BaseNode[], is_static?: boolean) {
		super("func_call", start);
		this.name = name;
		this.type = type || new Type("");
		this.params = params || [];

		// HACK: For testing
		this.is_static = !!is_static;
	}
}
