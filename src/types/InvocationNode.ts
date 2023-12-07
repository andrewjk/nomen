import type SyntaxNode from "./SyntaxNode";

export default interface InvocationNode extends SyntaxNode {
  node_type: "invoke";
  name: string;
  params: SyntaxNode[];
  type: string;
}
