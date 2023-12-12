import BaseNode from "./BaseNode";

export default class RangeNode extends BaseNode {
  left_value: BaseNode;
  right_value: BaseNode;
  inclusive: boolean;

  constructor(
    start: number,
    left_value: BaseNode,
    right_value: BaseNode,
    inclusive: boolean,
  ) {
    super("range", start);
    this.left_value = left_value;
    this.right_value = right_value;
    this.inclusive = inclusive;
  }
}
