import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import parse_expression from "./parse_expression.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";

export default function parse_function_call_parameter(
	node: FunctionCallNode | AccessFunctionCallNode,
	status: ParseStatus,
) {
	const param = parse_expression(status);
	node.params.push(param);

	// Next parameter
	if (accept(",", status)) {
		parse_function_call_parameter(node, status);
	}
}
