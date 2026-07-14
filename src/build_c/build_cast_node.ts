import CastNode from "../nodes/CastNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_cast_node(node: CastNode, status: BuildStatus) {
	// If the cast has an operator function (#op_as), emit a function call
	if (node.operator_func) {
		const { struct_name, func_name, mangled_name } = node.operator_func;
		const call_name = mangled_name || `${struct_name}_${c_function_name(func_name)}`;
		const source_type = type_from_value_node(node.value).name;
		const source_struct = status.structs.find((s) => s.name === source_type && !s.is_simple_type);
		status.code += `${call_name}(`;
		if (source_struct) {
			status.code += `&`;
		}
		build_node(node.value, status);
		status.code += `)`;
		return;
	}

	const is_struct = !!status.structs.find(
		(s) => s.name === node.target_type.name && !s.is_simple_type,
	);
	const prefix = is_struct ? "struct " : "";
	status.code += `(${prefix}${c_type(node.target_type.name)})`;
	build_node(node.value, status);
}
