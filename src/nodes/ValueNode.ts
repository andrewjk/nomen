import BaseNode from "./BaseNode";
import Type from "./Type";

export default class ValueNode extends BaseNode {
  value: string;
  type: Type;

  constructor(start: number, value: string, type?: string | Type) {
    super("value", start);
    this.value = value;
    this.type = typeof type === "string" ? new Type(type) : type || new Type("");
  }
}
