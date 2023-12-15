import BaseNode from "./BaseNode";
import type BlockNode from "./BlockNode";

export default class RootNode extends BaseNode implements BlockNode {
  statements: BaseNode[];

  constructor(statements?: BaseNode[]) {
    super("root", 0);
    this.statements = statements || [];
  }
}
