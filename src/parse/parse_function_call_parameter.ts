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
	const is_move = accept("move", status);
	// Mark the argument expression: inside call parens a `(...) { ... }`
	// group is an inline block-body lambda (parse_expression's lookahead).
	status.call_arg_depth = (status.call_arg_depth ?? 0) + 1;
	const param = parse_expression(status);
	status.call_arg_depth = (status.call_arg_depth ?? 1) - 1;
	node.params.push(param);
	const param_index = node.params.length - 1;
	if (is_ref) {
		if (!node.ref_param_indices) node.ref_param_indices = [];
		node.ref_param_indices.push(param_index);
	}
	if (is_move) {
		if (!node.move_param_indices) node.move_param_indices = [];
		node.move_param_indices.push(param_index);
	}
	if (peek_current(status) === "swap") {
		accept("swap", status);
		if (!node.swap_params) node.swap_params = new Map();
		status.call_arg_depth = (status.call_arg_depth ?? 0) + 1;
		const swap_expr = parse_expression(status);
		status.call_arg_depth = (status.call_arg_depth ?? 1) - 1;
		node.swap_params.set(param_index, swap_expr);
	}

	if (accept(",", status)) {
		if (peek_current(status) === ")") {
			return;
		}
		parse_function_call_parameter(node, status);
	}
}
