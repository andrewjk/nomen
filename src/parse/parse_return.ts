import add_error from "../add_error.ts";
import { is_returning_node } from "../nodes/check_node_type.ts";
import type ReturningNode from "../nodes/ReturningNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import parse_expression from "./parse_expression.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import get_index from "./utils/get_index.ts";

export default function parse_return(status: ParseStatus) {
  const start = get_index(status);
  accept("return", status);
  // TODO: Allow this anywhere?
  accept("~", status);
  const value = parse_expression(status);
  const ret = new ReturnNode(start, value);

  add_to_parent(ret, "Return statement", status);

  // Go up the stack looking for a returning node
  let func: ReturningNode | null = null;
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (is_returning_node(status.stack[i])) {
      func = status.stack[i] as ReturningNode;
      break;
    }
  }

  if (func) {
    func.has_return = true;
  } else {
    add_error(status, "Return must be inside an expression", get_index(status));
  }
}
