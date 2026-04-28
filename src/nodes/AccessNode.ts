import AccessFieldNode from "./AccessFieldNode.ts";
import AccessFunctionCallNode from "./AccessFunctionCallNode.ts";
import AccessIndexNode from "./AccessIndexNode.ts";
import BaseNode from "./BaseNode.ts";

export default class AccessNode extends BaseNode {
  target: BaseNode;
  access: AccessFieldNode | AccessFunctionCallNode | AccessIndexNode;

  constructor(
    start: number,
    target: BaseNode,
    access: AccessFieldNode | AccessFunctionCallNode | AccessIndexNode,
  ) {
    super("access", start);
    this.target = target;
    this.access = access;
  }
}
