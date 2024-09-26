import BaseNode from "./BaseNode";
import Type from "./Type";

export default class DeclarationNode extends BaseNode {
  visibility: "inherit" | "pub" | "mod" | "private";
  declaration: "const" | "var";
  name: string;
  type: Type;
  value?: BaseNode;
  name_start?: number;
  type_start?: number;

  constructor(
    start: number,
    visibility: "inherit" | "pub" | "mod" | "private",
    declaration: "const" | "var",
    name: string,
    type?: string | Type,
    value?: BaseNode,
  ) {
    super("declare", start);
    this.visibility = visibility;
    this.declaration = declaration;
    this.name = name;
    this.type = typeof type === "string" ? new Type(type) : type || new Type("");
    this.value = value;
  }
}
