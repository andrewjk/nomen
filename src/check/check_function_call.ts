import AccessFunctionNode from "../nodes/AccessFunctionNode";
import FunctionCallNode from "../nodes/FunctionCallNode";
import FunctionNode from "../nodes/FunctionNode";
import type CheckStatus from "./CheckStatus";
import check_node from "./check_node";
import check_type_and_value_match from "./utils/check_type_and_value_match";
import type_from_value_node from "./utils/type_from_value_node";
import value_from_value_node from "./utils/value_from_value_node";

export default function check_function_call(
  node: FunctionCallNode | AccessFunctionNode,
  status: CheckStatus,
  func?: FunctionNode,
) {
  for (let param of node.params) {
    check_node(param, status);
  }

  // HACK:
  if (func) {
    node.type = func.return_type;
  }
  if (!func) {
    status.errors.push({
      message: `Function not found: ${node.name}`,
      start: node.start,
    });
  } else if (node.params.length > func.params.length) {
    status.errors.push({
      message: `Too many parameters for function: ${node.name}`,
      start: node.start,
    });
  } else if (node.params.length < func.params.length) {
    status.errors.push({
      message: `Parameters missing for function: ${node.name}`,
      start: node.start,
    });
  } else if (func.visibility === "private") {
    // TODO: You CAN do this from within the correct scope
    status.errors.push({
      message: `Can't access secret function: ${node.name}`,
      start: node.start,
    });
  } else {
    node.params.forEach((param, i) => {
      check_type_and_value_match(
        func.params[i].type,
        type_from_value_node(param, status),
        value_from_value_node(param),
        status,
        param.start,
        "param",
      );
    });
  }
}
