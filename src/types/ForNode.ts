import type ParseNode from "./ParseNode";

export default interface ForNode extends ParseNode {
  node_type: "for";
  item?: ParseNode;
  index?: ParseNode;
  list?: ParseNode;
}
