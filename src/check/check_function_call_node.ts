import FunctionCallNode from "../nodes/FunctionCallNode";
import type CheckStatus from "./CheckStatus";
import check_function_call from "./check_function_call";

export default function check_function_call_node(node: FunctionCallNode, status: CheckStatus) {
  const func = status.functions.find((f) => f.name === node.name);
  check_function_call(node, status, func);
}
