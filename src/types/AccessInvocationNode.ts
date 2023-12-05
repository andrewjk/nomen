import type ParseNode from "./ParseNode";

export default interface AccessInvocationNode extends ParseNode {
  node_type: "accinv";
  name: string;
  params: ParseNode[];
  type: string;
  // HACK: This should probably be on AccessNode
  static?: boolean;
}
