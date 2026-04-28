import BaseNode from "./BaseNode.ts";

export default class AssignmentNode extends BaseNode {
  left_value: BaseNode;
  right_value: BaseNode;

  constructor(start: number, left_value: BaseNode, right_value: BaseNode) {
    super("assign", start);
    this.left_value = left_value;
    this.right_value = right_value;
  }
}
