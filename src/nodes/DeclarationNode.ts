import BaseNode from "./BaseNode";
import Type from "./Type";

export default class DeclarationNode extends BaseNode {
  declaration: "const" | "var";
  name: string;
  type: Type;
  value?: BaseNode;
  name_start?: number;
  type_start?: number;

  constructor(
    start: number,
    declaration: "const" | "var",
    name: string,
    type?: string | Type,
    value?: BaseNode,
  ) {
    super("declare", start);
    this.declaration = declaration;
    this.name = name;
    this.type = typeof type === "string" ? new Type(type) : type || new Type("");
    this.value = value;
  }
}
