import ForLoopNode from "../nodes/ForLoopNode";
import ValueNode from "../nodes/ValueNode";
import type ParseStatus from "./ParseStatus";
import parse_expression from "./parse_expression";
import parse_statement from "./parse_statement";
import accept from "./utils/accept";
import add_to_parent from "./utils/add_to_parent";
import consume from "./utils/consume";
import expect from "./utils/expect";
import get_index from "./utils/get_index";

export default function parse_for_loop(status: ParseStatus) {
  const for_start = get_index(status);
  accept("for", status);
  const start = get_index(status);
  const value = consume(status);
  const item = new ValueNode(start, value);
  // TODO: index option?
  if (expect("in", status)) {
    const list = parse_expression(status);
    if (expect("{", status)) {
      const for_loop = new ForLoopNode(for_start, item, list);

      status.stack.push(for_loop);
      parse_statement(status);
      expect("}", status);
      status.stack.pop();

      add_to_parent(for_loop, "For loop", status);
    }
  }
}
