import BaseNode from "./BaseNode";
import Type from "./Type";

export default class GroupedNode extends BaseNode {
  value: BaseNode;

  constructor(start: number, value: BaseNode) {
    super("grouped", start);
    this.value = value;
  }
}
