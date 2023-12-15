import BaseNode from "./BaseNode";
import type BlockNode from "./BlockNode";
import ValueNode from "./ValueNode";

export default class ForLoopNode extends BaseNode implements BlockNode {
  item: ValueNode;
  list: BaseNode;
  index?: BaseNode;
  statements: BaseNode[];

  constructor(start: number, item: ValueNode, list: BaseNode, statements?: BaseNode[]) {
    super("for", start);
    this.item = item;
    this.list = list;
    this.statements = statements || [];
  }
}
