import type FieldAccessNode from "./FieldAccessNode";
import type InvocationNode from "./InvocationNode";
import type ParseNode from "./ParseNode";

export default interface AccessNode extends ParseNode {
  node_type: "access";
  source: ParseNode;
  access: FieldAccessNode | InvocationNode;
}
