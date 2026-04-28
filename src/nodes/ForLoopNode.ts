import BaseNode from "./BaseNode.ts";
import type BlockNode from "./BlockNode.ts";
import ValueNode from "./ValueNode.ts";

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
