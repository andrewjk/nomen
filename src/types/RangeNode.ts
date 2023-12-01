import type ParseNode from "./ParseNode";

export default interface RangeNode extends ParseNode {
  node_type: "range";
  left_value?: ParseNode;
  right_value?: ParseNode;
  inclusive: boolean;
}
