import type SyntaxNode from "./SyntaxNode";

export default interface ParameterNode extends SyntaxNode {
  node_type: "param";
  name: string;
  type: string;
  default_value?: string;
  type_start?: number;
  default_value_start?: number;
}
