import BaseNode from "./BaseNode";
import BlockNode from "./BlockNode";

export default class RootNode extends BlockNode {
  constructor(statements?: BaseNode[]) {
    super("root", 0);
    this.statements = statements || [];
  }
}
