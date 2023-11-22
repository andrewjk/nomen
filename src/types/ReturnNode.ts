import type ParseNode from "./ParseNode";

export default interface ReturnNode extends ParseNode {
  node_type: "ret";
  value: string;
  type: string;
}
