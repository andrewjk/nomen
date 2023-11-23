import type DeclarationNode from "./DeclarationNode";
import type FunctionNode from "./FunctionNode";
import type ParseNode from "./ParseNode";

export default interface TraitNode extends ParseNode {
  node_type: "trait";
  name: string;
  fields: DeclarationNode[];
  functions: FunctionNode[];
}
