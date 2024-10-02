import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode";
import FunctionCallNode from "../nodes/FunctionCallNode";
import type ParseStatus from "./ParseStatus";
import parse_expression from "./parse_expression";
import accept from "./utils/accept";

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
