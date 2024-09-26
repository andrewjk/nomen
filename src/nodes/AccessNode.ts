import AccessFieldNode from "./AccessFieldNode";
import AccessFunctionNode from "./AccessFunctionNode";
import BaseNode from "./BaseNode";

export default class AccessNode extends BaseNode {
  source: BaseNode;
  access: AccessFieldNode | AccessFunctionNode;

  constructor(start: number, source: BaseNode, access: AccessFieldNode | AccessFunctionNode) {
    super("access", start);
    this.source = source;
    this.access = access;
  }
}
