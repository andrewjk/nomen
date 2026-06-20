import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class AccessFunctionCallNode extends BaseNode {
	name: string;
	type: Type;
	params: BaseNode[];

	is_static?: boolean;
	ref_param_indices?: number[];
	mov_param_indices?: number[];
	swap_params?: Map<number, BaseNode>;
	variadic_param_name?: string;
	variadic_param_index?: number;
	mangled_name?: string;

	constructor(start: number, name: string, type?: Type, params?: BaseNode[], is_static?: boolean) {
		super("access_func", start);
		this.name = name;
		this.type = type || new Type("");
		this.params = params || [];

		// HACK: For testing
		this.is_static = !!is_static;
	}
}
