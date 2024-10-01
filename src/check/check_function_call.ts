import AccessFunctionNode from "../nodes/AccessFunctionNode";
import FunctionCallNode from "../nodes/FunctionCallNode";
import FunctionNode from "../nodes/FunctionNode";
import Type from "../nodes/Type";
import type CheckStatus from "./CheckStatus";
import check_node from "./check_node";
import check_type_and_value_match from "./utils/check_type_and_value_match";
import type_from_value_node from "./utils/type_from_value_node";
import value_from_value_node from "./utils/value_from_value_node";

export default function check_function_call(
  node: FunctionCallNode | AccessFunctionNode,
  status: CheckStatus,
  func: FunctionNode | undefined,
  target_type?: Type,
) {
  // HACK: do checks at the top so that we can use printf -- remove this when we
  // have string interpolation and/or function overloading
  for (let param of node.params) {
    check_node(param, status);
  }

  // Make sure the function exists
  if (!func) {
    status.errors.push({
      message: `Function not found: ${node.name}`,
      start: node.start,
    });
    return;
  }

  // Make sure it's not a private function that we don't have access to
  if (
    func.visibility === "private" &&
    !status.structs.find((s) => s.name === target_type?.name)?.privates_visible
  ) {
    status.errors.push({
      message: `Can't access private function: ${node.name}`,
      start: node.start,
    });
    return;
  }

  // The node's type is the type that is returned from the function
  node.type = func.return_type;

  // Check params length
  let expected_param_count = func.params.length;
  if (target_type && func.params[0]?.is_self_param) {
    expected_param_count -= 1;
  }
  if (node.params.length > expected_param_count) {
    status.errors.push({
      message: `Too many parameters for function: ${node.name}`,
      start: node.start,
    });
    return;
  } else if (node.params.length < expected_param_count) {
    status.errors.push({
      message: `Parameters missing for function: ${node.name}`,
      start: node.start,
    });
    return;
  }

  // Check each param
  for (let [i, param] of node.params.entries()) {
    check_node(param, status);

    check_type_and_value_match(
      func.params[i].type,
      type_from_value_node(param, status),
      value_from_value_node(param),
      status,
      param.start,
      "param",
    );
  }
}
