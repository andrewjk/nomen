import add_error from "../add_error";
import OperationNode from "../nodes/OperationNode";
import Type from "../nodes/Type";
import type CheckStatus from "./CheckStatus";
import check_node from "./check_node";
import check_type_and_value_match from "./utils/check_type_and_value_match";
import type_from_value_node from "./utils/type_from_value_node";
import value_from_value_node from "./utils/value_from_value_node";

export default function check_operation_node(op: OperationNode, status: CheckStatus) {
  check_node(op.left_value, status);
  check_node(op.right_value, status);

  const left_type = type_from_value_node(op.left_value, status);
  const right_type = type_from_value_node(op.right_value, status);
  check_type_and_value_match(
    left_type,
    right_type,
    value_from_value_node(op.right_value),
    status,
    op.right_value.start,
    "operation",
  );

  // HACK: this needs to come from operator funcs for each operator and type combination
  switch (op.op) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "%": {
      //op.type = new Type("int");
      op.type = left_type;
      break;
    }
    case "==":
    case "!=":
    case ">":
    case ">=":
    case "<":
    case "<=":
    case "&&":
    case "||": {
      op.type = new Type("bool");
      break;
    }
    default: {
      add_error(status, `Unknown operator: ${op.op}`, op.start);
    }
  }
}
