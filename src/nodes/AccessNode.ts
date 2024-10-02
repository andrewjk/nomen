import AccessFieldNode from "./AccessFieldNode";
import AccessFunctionCallNode from "./AccessFunctionCallNode";
import BaseNode from "./BaseNode";

export default class AccessNode extends BaseNode {
  target: BaseNode;
  access: AccessFieldNode | AccessFunctionCallNode;

  constructor(start: number, target: BaseNode, access: AccessFieldNode | AccessFunctionCallNode) {
    super("access", start);
    this.target = target;
    this.access = access;
  }
}
