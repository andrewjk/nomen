import type SyntaxNode from "./SyntaxNode";

export default interface AssignmentNode extends SyntaxNode {
  node_type: "assign";
  left_value?: SyntaxNode;
  right_value?: SyntaxNode;
}
