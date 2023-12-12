import BaseNode from "./BaseNode";

type Operator = "+" | "-";

export default class OperationNode extends BaseNode {
  op: Operator;
  left_value: BaseNode;
  right_value: BaseNode;
  type: string;

  constructor(
    start: number,
    op: Operator,
    left_value: BaseNode,
    right_value: BaseNode,
    type?: string,
  ) {
    super("op", start);
    this.op = op;
    this.left_value = left_value;
    this.right_value = right_value;
    this.type = type || "";
  }
}
