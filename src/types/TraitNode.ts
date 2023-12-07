import type DeclarationNode from "./DeclarationNode";
import type FunctionNode from "./FunctionNode";
import type SyntaxNode from "./SyntaxNode";

export default interface TraitNode extends SyntaxNode {
  node_type: "trait";
  name: string;
  fields: DeclarationNode[];
  functions: FunctionNode[];
}
