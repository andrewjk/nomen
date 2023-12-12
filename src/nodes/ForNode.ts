import BaseNode from "./BaseNode";
import BlockNode from "./BlockNode";
import ValueNode from "./ValueNode";

export default class ForNode extends BlockNode {
  item: ValueNode;
  list: BaseNode;
  index?: BaseNode;

  constructor(start: number, item: ValueNode, list: BaseNode) {
    super("for", start);
    this.item = item;
    this.list = list;
  }
}
