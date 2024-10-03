import BaseNode from "./BaseNode";
import Type from "./Type";

export default class ReturnNode extends BaseNode {
  value: BaseNode;
  type: Type;

  from_c?: boolean;

  constructor(start: number, value: BaseNode, type?: Type) {
    super("return", start);
    this.value = value;
    this.type = type || new Type("");
  }
}
