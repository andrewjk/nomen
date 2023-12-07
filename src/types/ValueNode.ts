import type SyntaxNode from "./SyntaxNode";

export default interface ValueNode extends SyntaxNode {
  node_type: "value";
  value: string;
  type: string;
}
