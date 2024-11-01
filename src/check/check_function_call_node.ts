import FunctionCallNode from "../nodes/FunctionCallNode";
import FunctionNode from "../nodes/FunctionNode";
import ParameterNode from "../nodes/ParameterNode";
import type CheckStatus from "./CheckStatus";
import check_function_call from "./check_function_call";

export default function check_function_call_node(node: FunctionCallNode, status: CheckStatus) {
  let func = status.functions.find((f) => f.name === node.name);

  // We're making a fake string_interpolate method for now, but it should be a real one
  if (!func && node.name.startsWith("_string_interpolate_")) {
    const length = parseInt(node.name.substring("_string_interpolate_".length));
    func = new FunctionNode(0, "pub", node.name, node.type, [
      new ParameterNode(0, "pattern"),
      ...Array.from({ length }, (_, i) => new ParameterNode(0, `arg${i + 1}`)),
    ]);
  }

  // Make sure the function exists
  if (!func) {
    status.errors.push({
      message: `Function not found: ${node.name}`,
      start: node.start,
    });
    return;
  }

  check_function_call(node, status, func);
}
