import type SyntaxNode from "./SyntaxNode";

export default interface ArrayValuesNode extends SyntaxNode {
  node_type: "array";
  values: SyntaxNode[];
  type: string;
}
