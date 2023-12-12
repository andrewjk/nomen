import AccessFieldNode from "./AccessFieldNode";
import AccessInvocationNode from "./AccessInvocationNode";
import BaseNode from "./BaseNode";

export default class AccessNode extends BaseNode {
  source: BaseNode;
  access: AccessFieldNode | AccessInvocationNode;

  constructor(start: number, source: BaseNode, access: AccessFieldNode | AccessInvocationNode) {
    super("access", start);
    this.source = source;
    this.access = access;
  }
}
