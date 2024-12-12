import AccessFieldNode from "./AccessFieldNode";
import AccessFunctionCallNode from "./AccessFunctionCallNode";
import AccessIndexNode from "./AccessIndexNode";
import BaseNode from "./BaseNode";

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
