import type ParseNode from "./ParseNode";

export default interface ParameterNode extends ParseNode {
  node_type: "param";
  name: string;
  type: string;
  default_value?: string;
  type_start?: number;
  default_value_start?: number;
}
