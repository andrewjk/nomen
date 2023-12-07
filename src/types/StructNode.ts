import type DeclarationNode from "./DeclarationNode";
import type FunctionNode from "./FunctionNode";
import type SyntaxNode from "./SyntaxNode";

export default interface StructNode extends SyntaxNode {
  node_type: "struct";
  name: string;
  traits: string[];
  fields: DeclarationNode[];
  functions: FunctionNode[];
}
