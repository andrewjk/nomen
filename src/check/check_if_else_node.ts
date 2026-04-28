import add_error from "../add_error.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import clone_status from "./utils/clone_status.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";

export default function check_if_else_node(if_else: IfElseNode, status: CheckStatus) {
  check_node(if_else.condition, status);
  const condition_type = type_from_value_node(if_else.condition, status);
  if (type_name(condition_type) !== "bool") {
    add_error(
      status,
      `If/else condition must be a bool, not ${type_name(condition_type)}`,
      if_else.condition.start,
    );
  }

  status.stack.push(if_else);
  let if_status = clone_status(status);
  let else_status = clone_status(status);
  if (if_else.if_branch) {
    check_block_node(if_else.if_branch, if_status);
  }
  if (if_else.else_branch) {
    check_block_node(if_else.else_branch, else_status);
  }
  status.stack.pop();

  for (let [i, value] of status.values.entries()) {
    if (value.declaration === "const" && !value.is_set) {
      let is_set_count =
        0 + (if_status.values[i].is_set ? 1 : 0) + (else_status.values[i].is_set ? 1 : 0);
      if (is_set_count === 2) {
        value.is_set = true;
      } else if (is_set_count === 1) {
        add_error(status, `Const set incompletely: ${value.name}`, if_else.start);
      }
    }
  }
}
