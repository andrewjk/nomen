import add_error from "../add_error";
import BreakNode from "../nodes/BreakNode";
import ContinueNode from "../nodes/ContinueNode";
import type CheckStatus from "./CheckStatus";

export default function check_break_or_continue_node(
  node: BreakNode | ContinueNode,
  status: CheckStatus,
) {
  // Go up the stack looking for a for or while node
  let found = false;
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (status.stack[i].node_type === "for" || status.stack[i].node_type === "while") {
      found = true;
      break;
    }
  }

  if (!found) {
    const description = node.node_type.substring(0, 1).toUpperCase() + node.node_type.substring(1);
    add_error(status, `${description} must be inside a for or while loop`, node.start);
  }
}
