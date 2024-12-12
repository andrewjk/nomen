import BaseNode from "./BaseNode";
import Type from "./Type";

export default class AccessIndexNode extends BaseNode {
  index: BaseNode;
  type: Type;

  constructor(start: number, index: BaseNode, type?: Type) {
    super("access_index", start);
    this.index = index;
    this.type = type || new Type("");
  }
}
