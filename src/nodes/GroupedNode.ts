import BaseNode from "./BaseNode.ts";

export default class GroupedNode extends BaseNode {
  value: BaseNode;

  constructor(start: number, value: BaseNode) {
    super("grouped", start);
    this.value = value;
  }
}
