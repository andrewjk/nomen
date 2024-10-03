import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode";
import DeclarationNode from "../nodes/DeclarationNode";
import FunctionCallNode from "../nodes/FunctionCallNode";
import FunctionNode from "../nodes/FunctionNode";
import Type from "../nodes/Type";
import ValueNode from "../nodes/ValueNode";
import type CheckStatus from "./CheckStatus";
import check_node from "./check_node";
import check_type_and_value_match from "./utils/check_type_and_value_match";
import type_from_value_node from "./utils/type_from_value_node";
import value_from_value_node from "./utils/value_from_value_node";

export default function check_function_call(
  node: FunctionCallNode | AccessFunctionCallNode,
  status: CheckStatus,
  func: FunctionNode | undefined,
  target_type?: Type,
) {
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
  node.is_static = func.is_static;

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
  //console.log("BEFORE", node.params);
  for (let [i, param] of node.params.entries()) {
    check_node(param, status);

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
    if (param.node_type !== "value") {
      const declaration_name = `_param_${status.var_name_counter.value++}`;
      status.hoisted_declarations.push(
        new DeclarationNode(param.start, "private", "const", declaration_name, param_type, param),
      );
      node.params.splice(i, 1, new ValueNode(param.start, declaration_name, param_type));
    }
  }
  //console.log("AFTER", node.params);

  //for (let i = 0; i < node.params.length; i++) {
  //  // Move the param into a declaration so that we can auto-free it later
  //  const param = node.params[i];
  //  const param_type = type_from_value_node(param, status);
  //  if (param.node_type !== "value") {
  //    const declaration_name = `_param_${status.unwound_counter++}`;
  //    status.unwound_declarations.push(
  //      new DeclarationNode(param.start, "private", "const", declaration_name, param_type, param),
  //    );
  //    node.params.splice(i, 1, new ValueNode(param.start, declaration_name, param_type));
  //  }
  //}
}
