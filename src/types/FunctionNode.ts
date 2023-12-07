import type ParameterNode from "./ParameterNode";
import type StatementNode from "./StatementNode";
import type SyntaxNode from "./SyntaxNode";

export default interface FunctionNode extends SyntaxNode, StatementNode {
  node_type: "func";
  name: string;
  params: ParameterNode[];
  return_type: string;
  has_body?: boolean;
  // TODO: Check all branches
  has_return?: boolean;
  return_type_start?: number;
  statements: SyntaxNode[];
}
