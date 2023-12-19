import BaseNode from "./BaseNode";
import type BlockNode from "./BlockNode";

export default class WhileLoopNode extends BaseNode implements BlockNode {
  condition: BaseNode;
  statements: BaseNode[];

  constructor(start: number, condition: BaseNode, statements?: BaseNode[]) {
    super("while", start);
    this.condition = condition;
    this.statements = statements || [];
  }
}
