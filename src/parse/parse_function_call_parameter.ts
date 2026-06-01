import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import parse_expression from "./parse_expression.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_function_call_parameter(
	node: FunctionCallNode | AccessFunctionCallNode,
	status: ParseStatus,
) {
	const is_ref = accept("ref", status);
	const is_mov = accept("mov", status);
	const param = parse_expression(status);
	node.params.push(param);
	const param_index = node.params.length - 1;
	if (is_ref) {
		if (!node.ref_param_indices) node.ref_param_indices = [];
		node.ref_param_indices.push(param_index);
	}
	if (is_mov) {
		if (!node.mov_param_indices) node.mov_param_indices = [];
		node.mov_param_indices.push(param_index);
	}
	if (peek_current(status) === "swap") {
		accept("swap", status);
		if (!node.swap_params) node.swap_params = new Map();
		node.swap_params.set(param_index, parse_expression(status));
	}

	if (accept(",", status)) {
		parse_function_call_parameter(node, status);
	}
}
