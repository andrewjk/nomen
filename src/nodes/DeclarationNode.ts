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
    type?: Type,
    value?: BaseNode,
  ) {
    super("declare", start);
    this.visibility = visibility;
    this.declaration = declaration;
    this.name = name;
    this.type = type || new Type("");
    this.value = value;
  }
}
