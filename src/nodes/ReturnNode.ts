import BaseNode from "./BaseNode";
import Type from "./Type";

export default class ReturnNode extends BaseNode {
  value: BaseNode;
  type: Type;

  constructor(start: number, value: BaseNode, type?: string | Type) {
    super("return", start);
    this.value = value;
    this.type = typeof type === "string" ? new Type(type) : type || new Type("");
  }
}
