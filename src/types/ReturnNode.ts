import type ParseNode from "./ParseNode";

export default interface ReturnNode extends ParseNode {
  node_type: "ret";
  value: ParseNode;
  type: string;
}
