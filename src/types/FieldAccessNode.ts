import type ParseNode from "./ParseNode";

export default interface FieldAccessNode extends ParseNode {
  node_type: "field";
  name: string;
  type: string;
}
