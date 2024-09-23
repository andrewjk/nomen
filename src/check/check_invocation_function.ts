import AccessInvocationNode from "../nodes/AccessInvocationNode";
import FunctionNode from "../nodes/FunctionNode";
import InvocationNode from "../nodes/InvocationNode";
import type CheckStatus from "./CheckStatus";
import check_node from "./check_node";
import check_type_and_value_match from "./utils/check_type_and_value_match";
import type_from_value_node from "./utils/type_from_value_node";
import value_from_value_node from "./utils/value_from_value_node";

export default function check_invocation_function(
  invoke: InvocationNode | AccessInvocationNode,
  status: CheckStatus,
  func?: FunctionNode,
) {
  for (let param of invoke.params) {
    check_node(param, status);
  }

  // HACK:
  if (func) {
    invoke.type = func.return_type;
  }
  if (!func) {
    status.errors.push({
      message: `Function not found: ${invoke.name}`,
      start: invoke.start,
    });
  } else if (invoke.params.length > func.params.length) {
    status.errors.push({
      message: `Too many parameters for function: ${invoke.name}`,
      start: invoke.start,
    });
  } else if (invoke.params.length < func.params.length) {
    status.errors.push({
      message: `Parameters missing for function: ${invoke.name}`,
      start: invoke.start,
    });
  } else if (func.visibility === "sec") {
    // TODO: You CAN do this from within the correct scope
    status.errors.push({
      message: `Can't access secret function: ${invoke.name}`,
      start: invoke.start,
    });
  } else {
    invoke.params.forEach((param, i) => {
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
