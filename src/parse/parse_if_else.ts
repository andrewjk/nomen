import BranchNode from "../nodes/BranchNode";
import IfElseNode from "../nodes/IfElseNode";
import type ParseStatus from "./ParseStatus";
import parse_expression from "./parse_expression";
import parse_return from "./parse_return";
import parse_statement from "./parse_statement";
import accept from "./utils/accept";
import expect from "./utils/expect";
import get_index from "./utils/get_index";

export default function parse_if_else(status: ParseStatus): IfElseNode {
  const if_start = get_index(status);
  accept("if", status);
  const condition = parse_expression(status);

  const if_else = new IfElseNode(if_start, condition);
  status.stack.push(if_else);

  let if_branch = parse_if_branch(status);
  if (if_branch) {
    if_else.if_branch = if_branch;
  }

  if (accept("else", status)) {
    let else_branch = parse_if_branch(status);
    if (else_branch) {
      if_else.else_branch = else_branch;
    }
  }

  status.stack.pop();

  return if_else;
}

function parse_if_branch(status: ParseStatus): BranchNode | null {
  const short_if = accept("~", status, false) || accept("return", status, false);
  if (short_if || expect("{", status)) {
    const if_branch = new BranchNode(get_index(status));
    status.stack.push(if_branch);

    if (short_if) {
      parse_return(status);
    } else {
      parse_statement(status);
    }

    if (!short_if) {
      expect("}", status);
    }

    status.stack.pop();
    return if_branch;
  }

  return null;
}
