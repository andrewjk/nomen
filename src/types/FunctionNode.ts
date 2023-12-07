import type ParameterNode from "./ParameterNode";
import type ParseNode from "./ParseNode";

export default interface FunctionNode extends ParseNode {
  node_type: "func";
  name: string;
  params: ParameterNode[];
  return_type: string;
  has_body?: boolean;
  // TODO: Check all branches
  has_return?: boolean;
  return_type_start?: number;
}
