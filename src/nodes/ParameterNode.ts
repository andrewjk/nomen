import BaseNode from "./BaseNode";

export default class ParameterNode extends BaseNode {
  name: string;
  type: string;
  default_value?: string;
  type_start?: number;
  default_value_start?: number;

  constructor(
    start: number,
    name: string,
    type?: string,
    default_value?: string,
  ) {
    super("param", start);
    this.name = name;
    this.type = type || "";
    this.default_value = default_value;
  }
}
