import BranchNode from "../nodes/BranchNode";
import IfElseNode from "../nodes/IfElseNode";
import type ParseStatus from "./ParseStatus";
import parse_expression from "./parse_expression";
import parse_return from "./parse_return";
import parse_statement from "./parse_statement";
import accept from "./utils/accept";
import expect from "./utils/expect";
import get_index from "./utils/get_index";

export default function parse_if_else(status: ParseStatus): IfElseNode | null {
  const if_start = get_index(status);
  accept("if", status);
  const condition = parse_expression(status);
  const short_if = accept("=>", status, false);
  if (short_if || expect("{", status)) {
    const if_branch = new BranchNode(get_index(status));
    const if_else = new IfElseNode(if_start, condition, if_branch);

    status.stack.push(if_else);
    status.stack.push(if_branch);
    if (short_if) {
      parse_return(status);
    } else {
      parse_statement(status);
    }

    if (accept("else", status)) {
      if ((short_if && expect("=>", status, false)) || (!short_if && expect("{", status))) {
        const else_branch = new BranchNode(get_index(status));
        if_else.else_branch = else_branch;

        status.stack.push(else_branch);
        if (short_if) {
          parse_return(status);
        } else {
          parse_statement(status);
        }
        status.stack.pop();
      }
    }

    if (!short_if) {
      expect("}", status);
    }

    status.stack.pop();
    status.stack.pop();

    return if_else;
  }

  return null;
}
