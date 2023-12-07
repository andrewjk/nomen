import type ParseNode from "./ParseNode";

export default interface DeclarationNode extends ParseNode {
  node_type: "decl";
  declaration: "const" | "var";
  name: string;
  type: string;
  value?: ParseNode;
  name_start?: number;
  type_start?: number;
}
