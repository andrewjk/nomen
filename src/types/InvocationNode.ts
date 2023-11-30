import type ParseNode from "./ParseNode";

export default interface InvocationNode extends ParseNode {
  node_type: "invoke";
  name: string;
  params: ParseNode[];
  type: string;
  // HACK: This should probably be on AccessNode
  static?: boolean;
}
