import type SyntaxNode from "./SyntaxNode";

export default interface DeclarationNode extends SyntaxNode {
  node_type: "decl";
  declaration: "const" | "var";
  name: string;
  type: string;
  value?: SyntaxNode;
  name_start?: number;
  type_start?: number;
}
