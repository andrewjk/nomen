import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_function_call_node(node: FunctionCallNode, status: BuildStatus) {
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

	if (node.swap_params?.size) {
		for (const [idx, swap_expr] of node.swap_params) {
			const source = node.params[idx];
			if (!source) continue;
			status.code += `; `;

			if (
				source.node_type === "access" &&
				(source as AccessNode).access.node_type === "access_field"
			) {
				const src_access = source as AccessNode;
				const src_field = (src_access.access as AccessFieldNode).name;
				build_node(src_access.target, status);
				status.code += `.${src_field} = `;
				build_node(swap_expr, status);
			} else if (source.node_type === "value") {
				const src_name = (source as ValueNode).value;
				status.code += `${src_name} = `;
				build_node(swap_expr, status);
			}
		}
	}
}
