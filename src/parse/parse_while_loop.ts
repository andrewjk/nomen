import WhileLoopNode from "../nodes/WhileLoopNode";
import type ParseStatus from "./ParseStatus";
import parse_expression from "./parse_expression";
import parse_statement from "./parse_statement";
import accept from "./utils/accept";
import add_to_parent from "./utils/add_to_parent";
import expect from "./utils/expect";
import get_index from "./utils/get_index";

export default function parse_while_loop(status: ParseStatus) {
  const while_start = get_index(status);
  accept("while", status);
  const condition = parse_expression(status);
  if (expect("{", status)) {
    const while_loop = new WhileLoopNode(while_start, condition);

    status.stack.push(while_loop);
    parse_statement(status);
    expect("}", status);
    status.stack.pop();

    add_to_parent(while_loop, "While loop", status);
  }
}
