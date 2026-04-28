import { is_returning_node } from "../nodes/check_node_type.ts";
import type ReturningNode from "../nodes/ReturningNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_return_node(ret: ReturnNode, status: CheckStatus) {
  if (!check_node(ret.value, status)) {
    return;
  }

  ret.type = type_from_value_node(ret.value, status);

  // Go up the stack looking for a returning node
  let func: ReturningNode | null = null;
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (is_returning_node(status.stack[i])) {
      func = status.stack[i] as ReturningNode;
    }
  }

  if (func) {
    if (func.return_type.name) {
      if (func.return_type.name !== "?") {
        const return_type = type_from_value_node(ret.value, status);
        const return_value = value_from_value_node(ret.value);
        // Ignore values that are returned "from_c" because we can't check them
        // -- we just have to trust the function's return type
        if (return_value === '"from_c"') {
          ret.from_c = true;
        } else {
          check_type_and_value_match(
            func.return_type,
            return_type,
            return_value,
            status,
            ret.value.start,
            "return",
          );
          // HACK: need to check more thoroughly
          func.return_type.is_static = return_type.is_static;
        }
      }
    } else {
      func.return_type = ret.type;
    }
  }
}
