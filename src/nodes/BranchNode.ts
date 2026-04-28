import BaseNode from "./BaseNode.ts";
import type BlockNode from "./BlockNode.ts";

/**
 * A branch such as the result of an IfElseNode, or the arm of a SwitchNode
 */
export default class BranchNode extends BaseNode implements BlockNode {
  statements: BaseNode[];

  constructor(start: number, statements?: BaseNode[]) {
    super("branch", start);
    this.statements = statements || [];
  }
}
