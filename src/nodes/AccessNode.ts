import AccessFieldNode from "./AccessFieldNode";
import AccessFunctionNode from "./AccessFunctionNode";
import BaseNode from "./BaseNode";

export default class AccessNode extends BaseNode {
  target: BaseNode;
  access: AccessFieldNode | AccessFunctionNode;

  constructor(start: number, target: BaseNode, access: AccessFieldNode | AccessFunctionNode) {
    super("access", start);
    this.target = target;
    this.access = access;
  }
}
