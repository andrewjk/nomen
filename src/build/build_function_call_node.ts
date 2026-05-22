import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_function_call_node(node: FunctionCallNode, status: BuildStatus) {
	// Check for struct constructor
	const is_struct = status.structs.find((s) => s.name === node.name && !s.is_simple_type);
	const func_name = is_struct ? `${node.name}_init` : node.name;
	status.code += `${func_name}(`;
	for (let i = 0; i < node.params.length; i++) {
		if (i > 0) {
			status.code += ", ";
		}

		const param_type = type_from_value_node(node.params[i]);
		const is_ref_param = node.ref_param_indices?.includes(i);
		if (
			status.structs.find((s) => s.name === param_type.name && !s.is_simple_type) ||
			status.traits.find((t) => t.name === param_type.name)
		) {
			status.code += `(void *)&`;
		} else if (is_ref_param) {
			status.code += `&`;
		}

		build_node(node.params[i], status);
	}
	status.code += ")";

	if (node.name.startsWith("_string_interpolate_")) {
		status.interpolate_string_counts.add(node.params.length - 1);
	}
}
