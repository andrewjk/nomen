import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import parse_expression from "./parse_expression.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";

export default function parse_function_call_parameter(
	node: FunctionCallNode | AccessFunctionCallNode,
	status: ParseStatus,
) {
	const is_ref = accept("ref", status);
	const is_mov = accept("mov", status);
	const param = parse_expression(status);
	node.params.push(param);
	if (is_ref) {
		if (!node.ref_param_indices) node.ref_param_indices = [];
		node.ref_param_indices.push(node.params.length - 1);
	}
	if (is_mov) {
		if (!node.mov_param_indices) node.mov_param_indices = [];
		node.mov_param_indices.push(node.params.length - 1);
	}

	if (accept(",", status)) {
		parse_function_call_parameter(node, status);
	}
}
