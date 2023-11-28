import type ParseNode from "./ParseNode";

export default interface DeclarationNode extends ParseNode {
  node_type: "decl";
  declaration: "const" | "var";
  name: string;
  value?: ParseNode;
  type: string;
}
