import type DeclarationNode from "./DeclarationNode";
import type FunctionNode from "./FunctionNode";
import type ParseNode from "./ParseNode";

export default interface StructNode extends ParseNode {
  node_type: "struct";
  name: string;
  traits: string[];
  fields: DeclarationNode[];
  functions: FunctionNode[];
}
