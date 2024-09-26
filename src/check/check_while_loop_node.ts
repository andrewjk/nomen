import WhileLoopNode from "../nodes/WhileLoopNode";
import type CheckStatus from "./CheckStatus";
import check_block_node from "./check_block_node";
import check_node from "./check_node";
import type_from_value_node from "./utils/type_from_value_node";
import type_name from "./utils/type_name";

export default function check_while_loop_node(while_loop: WhileLoopNode, status: CheckStatus) {
  check_node(while_loop.condition, status);
  const condition_type = type_from_value_node(while_loop.condition, status);
  if (type_name(condition_type) !== "bool") {
    status.errors.push({
      message: `While loop condition must be a bool, not ${type_name(condition_type)}`,
      start: while_loop.condition.start,
    });
  }

  const old_values = status.values;
  check_block_node(while_loop, status);
  status.values = old_values;
}
