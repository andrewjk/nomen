import FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import check_block_node from "./check_block_node.ts";
import check_function_parameter_node from "./check_function_parameter_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_exists from "./utils/check_type_exists.ts";
import clone_status from "./utils/clone_status.ts";

function is_generic_func(func: FunctionNode, status: CheckStatus): boolean {
	for (const param of func.params) {
		if (param.type.type_args?.length) continue;
		const struct = status.structs.findLast((s) => s.name === param.type.name);
		if (!struct?.is_generic) continue;
		const all_registered = struct.type_params.every((tp) => status.type_params.includes(tp));
		if (all_registered) continue;
		return true;
	}
	return false;
}

export default function check_function_node(func: FunctionNode, status: CheckStatus) {
	if (func.checked) return;
	func.checked = true;

	status.functions.push(func);

	if (is_generic_func(func, status)) {
		func.is_generic = true;
		return;
	}

	let function_status = clone_status(status);

	for (let param of func.params) {
		check_function_parameter_node(param, function_status);
	}

	if (func.return_type.name) {
		if (!check_type_exists(func.return_type, function_status, func.return_type_start!)) {
			func.return_type = new Type("?");
		}
	}

	check_block_node(func, function_status);
}
