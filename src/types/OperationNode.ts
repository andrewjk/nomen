import type ParseNode from "./ParseNode";

export default interface OperationNode extends ParseNode {
  node_type: "op";
  op: "+" | "-";
  left_value?: ParseNode;
  right_value?: ParseNode;
  type: string;
}
