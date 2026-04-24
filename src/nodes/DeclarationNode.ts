import BaseNode from "./BaseNode";
import ParameterNode from "./ParameterNode";
import Type from "./Type";

export default class DeclarationNode extends BaseNode {
  visibility: "inherit" | "pub" | "mod" | "priv";
  declaration: "const" | "var";
  name: string;
  type: Type;
  value?: BaseNode;
  name_start?: number;
  type_start?: number;
  func_params?: ParameterNode[];
  func_return_type?: Type;

  constructor(
    start: number,
    visibility: "inherit" | "pub" | "mod" | "priv",
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
