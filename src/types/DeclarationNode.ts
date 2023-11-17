import ParseNode from "./ParseNode";

export default interface DeclarationNode extends ParseNode {
  node_type: "dec";
  declaration: "const" | "var";
  name: string;
  value: string;
  type: string;
}
