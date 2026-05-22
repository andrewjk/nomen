import OperationNode from "../nodes/OperationNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_operation_node(node: OperationNode, status: BuildStatus) {
	if (node.op === "!") {
		status.code += `!`;
		build_node(node.right_value, status);
	} else if (node.op === "??") {
		status.code += `(`;
		build_node(node.left_value, status);
		status.code += ` ? `;
		build_node(node.left_value, status);
		status.code += ` : `;
		build_node(node.right_value, status);
		status.code += `)`;
	} else if (node.operator_func) {
		// Custom operator function call
		status.code += `${node.operator_func.struct_name}_${node.operator_func.func_name}(`;
		build_operand(node.left_value, status);
		status.code += ", ";
		build_operand(node.right_value, status);
		status.code += ")";
	} else {
		build_node(node.left_value, status);
		status.code += ` ${node.op} `;
		build_node(node.right_value, status);
	}
}

function build_operand(node: any, status: BuildStatus) {
	const param_type = type_from_value_node(node);
	if (
		status.structs.find((s) => s.name === param_type.name && !s.is_simple_type) ||
		status.traits.find((t) => t.name === param_type.name)
	) {
		status.code += `&`;
	}
	build_node(node, status);
}
