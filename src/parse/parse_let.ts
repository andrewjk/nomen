import { is_returning_node } from "../nodes/check_node_type.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import parse_expression from "./parse_expression.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import get_index from "./utils/get_index.ts";

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
    if (is_returning_node(node)) {
      func = node;
      break;
    }
  }

  if (func) {
    func.has_return = true;
  }
}
