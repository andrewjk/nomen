import ReturnNode from "../nodes/ReturnNode";
import ReturningNode from "../nodes/ReturningNode";
import { is_returning_node } from "../nodes/check_node_type";
import type ParseStatus from "./ParseStatus";
import parse_expression from "./parse_expression";
import accept from "./utils/accept";
import add_to_parent from "./utils/add_to_parent";
import get_index from "./utils/get_index";

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
    status.errors.push({
      message: "Return must be inside an expression",
      start: get_index(status),
    });
  }
}
