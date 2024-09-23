import IfElseNode from "../nodes/IfElseNode";
import type CheckStatus from "./CheckStatus";
import check_block_node from "./check_block_node";
import check_node from "./check_node";
import type_from_value_node from "./utils/type_from_value_node";
import type_name from "./utils/type_name";

export default function check_if_else_node(if_else: IfElseNode, status: CheckStatus) {
  check_node(if_else.condition, status);
  const condition_type = type_from_value_node(if_else.condition, status);
  if (type_name(condition_type) !== "bool") {
    status.errors.push({
      message: `If/else condition must be a bool, not ${type_name(condition_type)}`,
      start: if_else.condition.start,
    });
  }

  status.stack.push(if_else);
  check_block_node(if_else.if_branch, status);
  if (if_else.else_branch) {
    check_block_node(if_else.else_branch, status);
  }
  status.stack.pop();
}
