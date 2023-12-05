import type ParseNode from "./ParseNode";

export default interface AccessFieldNode extends ParseNode {
  node_type: "accfld";
  name: string;
  type: string;
}
