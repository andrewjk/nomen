import type AccessFieldNode from "./AccessFieldNode";
import type AccessInvocationNode from "./AccessInvocationNode";
import type SyntaxNode from "./SyntaxNode";

export default interface AccessNode extends SyntaxNode {
  node_type: "access";
  source: SyntaxNode;
  access: AccessFieldNode | AccessInvocationNode;
}
