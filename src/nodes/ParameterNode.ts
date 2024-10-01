import BaseNode from "./BaseNode";
import Type from "./Type";

export default class ParameterNode extends BaseNode {
  name: string;
  type: Type;
  default_value?: string;
  type_start?: number;
  default_value_start?: number;
  is_self_param?: boolean;

  constructor(
    start: number,
    name: string,
    type?: string | Type,
    default_value?: string,
    is_self_param?: boolean,
  ) {
    super("param", start);
    this.name = name;
    this.type = typeof type === "string" ? new Type(type) : type || new Type("");
    this.default_value = default_value;
    this.is_self_param = is_self_param;
  }
}
