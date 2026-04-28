import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class ParameterNode extends BaseNode {
  declaration: "const" | "var" = "const";
  name: string;
  type: Type;
  default_value?: BaseNode;
  type_start?: number;
  name_start?: number;
  default_value_start?: number;
  is_self_param?: boolean;
  is_copied?: boolean;

  constructor(
    start: number,
    name: string,
    type?: Type,
    default_value?: BaseNode,
    is_self_param?: boolean,
    declaration?: "const" | "var" | "cp",
  ) {
    super("param", start);
    this.name = name;
    this.type = type || new Type("");
    this.default_value = default_value;
    this.is_self_param = is_self_param;
    if (declaration) {
      this.declaration = declaration === "const" ? "const" : "var";
      if (declaration === "cp") {
        this.is_copied = true;
      }
    }
  }
}
