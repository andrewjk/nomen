import type ParseNode from "./ParseNode";
import type ValueNode from "./ValueNode";

export default interface ForNode extends ParseNode {
  node_type: "for";
  item?: ValueNode;
  index?: ParseNode;
  list?: ParseNode;
}
