import BaseNode from "./BaseNode";
import type BlockNode from "./BlockNode";

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
