import ReturnNode from "../nodes/ReturnNode";
import ReturningNode from "../nodes/ReturningNode";
import isReturningNode from "../nodes/isReturningNode";
import type CheckStatus from "./CheckStatus";
import check_node from "./check_node";
import check_type_and_value_match from "./utils/check_type_and_value_match";
import type_from_value_node from "./utils/type_from_value_node";
import value_from_value_node from "./utils/value_from_value_node";

export default function check_return_node(ret: ReturnNode, status: CheckStatus) {
  check_node(ret.value, status);

  ret.type = type_from_value_node(ret.value, status);

  // Go up the stack looking for a returning node
  let func: ReturningNode | null = null;
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (isReturningNode(status.stack[i])) {
      func = status.stack[i] as ReturningNode;
    }
  }

  if (func) {
    if (func.return_type.name) {
      if (func.return_type.name !== "?") {
        check_type_and_value_match(
          func.return_type,
          type_from_value_node(ret.value, status),
          value_from_value_node(ret.value),
          status,
          ret.value.start,
          "return",
        );
      }
    } else {
      func.return_type = ret.type;
    }
  }
}
