import BaseNode from "./BaseNode";
import BranchNode from "./BranchNode";
import type ReturningNode from "./ReturningNode";

export default class IfElseNode extends BaseNode implements ReturningNode {
  condition: BaseNode;
  return_type: string;
  if_branch: BranchNode;
  else_branch?: BranchNode;
  has_return?: boolean;

  constructor(
    start: number,
    condition: BaseNode,
    if_branch: BranchNode,
    else_branch?: BranchNode,
    return_type?: string,
  ) {
    super("if", start);
    this.condition = condition;
    this.if_branch = if_branch;
    this.else_branch = else_branch;
    // HACK: This is a ReturningNode, just like Function, but they are quite different...
    this.return_type = return_type || "";
    this.has_return = !!return_type;
  }
}
