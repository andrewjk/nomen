import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class ParameterNode extends BaseNode {
	declaration: "const" | "var" = "const";
	name: string;
	type: Type;
	default_value?: BaseNode;
	constraint?: BaseNode;
	type_start?: number;
	name_start?: number;
	default_value_start?: number;
	is_self_param?: boolean;
	is_copied?: boolean;
	// `is_moved` is inherited from BaseNode (a mov parameter / mov expression).
	is_ref?: boolean;
	is_variadic?: boolean;
	/**
	 * Set when this is a variadic tuple parameter (`...[T1, T2, ...]`).
	 * At the call site, consecutive arguments are grouped into tuples.
	 */
	is_variadic_tuple?: boolean;
	func_params?: ParameterNode[];
	func_return_type?: Type;

	constructor(
		start: number,
		name: string,
		type?: Type,
		default_value?: BaseNode,
		is_self_param?: boolean,
		declaration?: "const" | "var" | "cp" | "mov",
	) {
		super("param", start);
		this.name = name;
		this.type = type || new Type("");
		this.default_value = default_value;
		this.is_self_param = is_self_param;
		if (declaration) {
			this.declaration = declaration === "const" ? "const" : "var";
			if (declaration === "cp") {
				this.is_copied = true;
			}
			if (declaration === "mov") {
				this.is_moved = true;
			}
		}
	}
}
