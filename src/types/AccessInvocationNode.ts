import type SyntaxNode from "./SyntaxNode";

export default interface AccessInvocationNode extends SyntaxNode {
  node_type: "accinv";
  name: string;
  params: SyntaxNode[];
  type: string;
  // HACK: This should probably be on AccessNode
  static?: boolean;
}
