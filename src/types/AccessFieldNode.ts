import type SyntaxNode from "./SyntaxNode";

export default interface AccessFieldNode extends SyntaxNode {
  node_type: "accfld";
  name: string;
  type: string;
}
