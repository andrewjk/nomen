import type SyntaxNode from "./SyntaxNode";

export default interface OperationNode extends SyntaxNode {
  node_type: "op";
  op: "+" | "-";
  left_value?: SyntaxNode;
  right_value?: SyntaxNode;
  type: string;
}
