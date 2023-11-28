import type ParseNode from "./ParseNode";

export default interface ValueNode extends ParseNode {
  node_type: "value";
  value: string;
  type: string;
}
