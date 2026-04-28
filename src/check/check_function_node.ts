import FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import check_block_node from "./check_block_node.ts";
import check_function_parameter_node from "./check_function_parameter_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_exists from "./utils/check_type_exists.ts";
import clone_status from "./utils/clone_status.ts";

export default function check_function_node(func: FunctionNode, status: CheckStatus) {
	// The function can be called from outside and inside, so it needs to be added
	// to the status before cloning
	status.functions.push(func);

	let function_status = clone_status(status);

	for (let param of func.params) {
		check_function_parameter_node(param, function_status);
	}

	if (func.return_type.name) {
		if (!check_type_exists(func.return_type, function_status, func.return_type_start!)) {
			// Set the return type to the unknown type so that returns won't get checked
			func.return_type = new Type("?");
		}
	}

	check_block_node(func, function_status);
}
