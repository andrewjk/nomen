import add_error from "../add_error.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import clone_status from "./utils/clone_status.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";

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
