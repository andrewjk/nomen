import add_error from "../add_error.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_function_call(
  node: FunctionCallNode | AccessFunctionCallNode,
  status: CheckStatus,
  func: FunctionNode,
  target_type?: Type,
): boolean {
  // Make sure it's not a priv function that we don't have access to
  if (
    func.visibility === "priv" &&
    !status.structs.find((s) => s.name === target_type?.name)?.privates_visible
  ) {
    add_error(status, `Can't access priv function: ${node.name}`, node.start);
    return false;
  }

  // The node's type is the type that is returned from the function
  node.type = func.return_type;
  node.is_static = func.is_static;

  // Check params length (account for default values)
  let required_param_count = 0;
  for (const param of func.params) {
    if (!param.default_value) {
      required_param_count++;
    }
  }
  if (target_type && func.params[0]?.is_self_param) {
    required_param_count -= 1;
  }
  if (node.params.length > func.params.length) {
    add_error(status, `Too many parameters for function: ${node.name}`, node.start);
    return false;
  } else if (node.params.length < required_param_count) {
    add_error(status, `Parameters missing for function: ${node.name}`, node.start);
    return false;
  }

  // Check each param
  status.stack.push(node);

  for (let [i, param] of node.params.entries()) {
    if (!check_node(param, status)) {
      continue;
    }

    const param_type = type_from_value_node(param, status);
    const param_value = value_from_value_node(param);
    check_type_and_value_match(
      func.params[i].type,
      param_type,
      param_value,
      status,
      param.start,
      "param",
    );

    // Move the param into a declaration so that we can auto-free it later
    // TODO: Based on its expression type as well as its node_type
    // e.g. if it's a function that returns a string
    if (param.node_type !== "value") {
      const declaration_name = `_param_${status.var_name_counter.value++}`;
      status.allocations.push(
        new DeclarationNode(param.start, "priv", "const", declaration_name, param_type, param),
      );
      node.params.splice(i, 1, new ValueNode(param.start, declaration_name, param_type));
    }
  }

  status.stack.pop();

  return true;
}
