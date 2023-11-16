import ParseNode from "./ParseNode";

export default interface DeclarationNode extends ParseNode {
  nodetype: "decl";
  declaration: "const" | "var";
  name: string;
  value: string;
  type: string;
}
