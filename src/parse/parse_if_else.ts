import BranchNode from "../nodes/BranchNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";

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
  // Check for one-liner syntax: -> (expr)
  if (accept("->", status)) {
    if (expect("(", status)) {
      const branch_start = get_index(status);
      const value = parse_expression(status);
      expect(")", status);

      const branch = new BranchNode(branch_start);
      branch.statements.push(new ReturnNode(value.start, value));
      return branch;
    }
    return null;
  }

  // Block syntax: { ... }
  if (expect("{", status)) {
    const if_branch = new BranchNode(get_index(status));
    status.stack.push(if_branch);

    parse_statement(status);
    expect("}", status);

    status.stack.pop();
    return if_branch;
  }

  return null;
}
