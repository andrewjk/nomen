import type AccessFieldNode from "./AccessFieldNode";
import type AccessInvocationNode from "./AccessInvocationNode";
import type ParseNode from "./ParseNode";

export default interface AccessNode extends ParseNode {
  node_type: "access";
  source: ParseNode;
  access: AccessFieldNode | AccessInvocationNode;
}
