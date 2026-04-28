import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

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
