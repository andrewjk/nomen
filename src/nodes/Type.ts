import BaseNode from "./BaseNode.ts";

// TODO: Remove is_array and length, add generic arguments

export default class Type {
	name: string;
	is_static?: boolean;
	is_array?: boolean;
	is_ref?: boolean;

	length?: BaseNode;
	is_return_type?: boolean;
	is_nullable?: boolean;
	type_args?: Type[];
	func_params?: import("./ParameterNode.ts").default[];
	func_return_type?: Type;

	constructor(name: string, is_static?: boolean, is_array?: boolean, length?: BaseNode) {
		this.name = name;
		this.is_static = is_static;
		this.is_array = is_array;
		this.length = length;
	}
}
