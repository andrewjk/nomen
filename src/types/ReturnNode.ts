import type SyntaxNode from "./SyntaxNode";

export default interface ReturnNode extends SyntaxNode {
  node_type: "ret";
  value: SyntaxNode;
  type: string;
}
