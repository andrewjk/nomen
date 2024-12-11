import add_error from "../add_error";
import WhileLoopNode from "../nodes/WhileLoopNode";
import type CheckStatus from "./CheckStatus";
import check_block_node from "./check_block_node";
import check_node from "./check_node";
import clone_status from "./utils/clone_status";
import type_from_value_node from "./utils/type_from_value_node";
import type_name from "./utils/type_name";

export default function check_while_loop_node(while_loop: WhileLoopNode, status: CheckStatus) {
  let while_status = clone_status(status);

  check_node(while_loop.condition, while_status);
  const condition_type = type_from_value_node(while_loop.condition, while_status);
  if (type_name(condition_type) !== "bool") {
    add_error(
      while_status,
      `While loop condition must be a bool, not ${type_name(condition_type)}`,
      while_loop.condition.start,
    );
  }

  check_block_node(while_loop, while_status);
}
