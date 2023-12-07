import type SyntaxNode from "./SyntaxNode";

export default interface RangeNode extends SyntaxNode {
  node_type: "range";
  left_value?: SyntaxNode;
  right_value?: SyntaxNode;
  inclusive: boolean;
}
