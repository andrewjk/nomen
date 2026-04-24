import ReturnNode from "../nodes/ReturnNode";
import type ParseStatus from "./ParseStatus";
import parse_expression from "./parse_expression";
import accept from "./utils/accept";
import add_to_parent from "./utils/add_to_parent";
import get_index from "./utils/get_index";

export default function parse_let(status: ParseStatus) {
  const start = get_index(status);
  accept("let", status);
  const value = parse_expression(status);
  const ret = new ReturnNode(start, value);

  add_to_parent(ret, "Let expression", status);

  // Go up the stack looking for a returning node
  let func = null;
  for (let i = status.stack.length - 1; i >= 0; i--) {
    const node = status.stack[i];
    if (node.node_type === "if" || node.node_type === "func") {
      func = node;
      break;
    }
  }

  if (func) {
    func.has_return = true;
  }
}
