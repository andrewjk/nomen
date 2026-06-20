import FunctionNode from "../../nodes/FunctionNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";

export function find_function_by_params(
	functions: FunctionNode[],
	name: string,
	arg_types: Type[],
): FunctionNode | undefined {
	const candidates = functions.filter((f) => f.name === name);
	if (candidates.length === 0) return undefined;
	if (candidates.length === 1) return candidates[0];

	for (const func of candidates) {
		const params = func.params.filter((p) => !p.is_self_param);
		if (params.length !== arg_types.length) continue;
		let match = true;
		for (let i = 0; i < params.length; i++) {
			if (!types_match(params[i].type, arg_types[i])) {
				match = false;
				break;
			}
		}
		if (match) return func;
	}

	return candidates[candidates.length - 1];
}

function types_match(param_type: Type, arg_type: Type): boolean {
	if (!param_type.name && !arg_type.name) return true;
	if (param_type.name === arg_type.name) {
		if (param_type.is_array && arg_type.is_array) {
			return param_type.length === arg_type.length;
		}
		return param_type.is_array === arg_type.is_array;
	}
	return false;
}

export function is_overloaded(struct: StructNode, func_name: string): boolean {
	return struct.functions.filter((f) => f.name === func_name).length > 1;
}

function sanitize_label(name: string): string {
	return name.replace(/#/g, "");
}

export function mangled_label(func: FunctionNode, struct_name: string): string {
	const non_self = func.params.filter((p) => !p.is_self_param);
	const func_name = sanitize_label(func.name);
	if (non_self.length === 0) return `${struct_name}_${func_name}`;
	const suffix = non_self.map((p) => p.type.name || "any").join("_");
	return `${struct_name}_${func_name}_${suffix}`;
}
