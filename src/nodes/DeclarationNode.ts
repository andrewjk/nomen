import BaseNode from "./BaseNode";

export default class DeclarationNode extends BaseNode {
  declaration: "const" | "var";
  name: string;
  type: string;
  value?: BaseNode;
  name_start?: number;
  type_start?: number;

  constructor(
    start: number,
    declaration: "const" | "var",
    name: string,
    type?: string,
    value?: BaseNode,
  ) {
    super("declare", start);
    this.declaration = declaration;
    this.name = name;
    this.type = type || "";
    this.value = value;
  }
}
