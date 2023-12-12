import BaseNode from "./BaseNode";

export default class ValueNode extends BaseNode {
  value: string;
  type: string;

  constructor(start: number, value: string, type?: string) {
    super("value", start);
    this.value = value;
    this.type = type || "";
  }
}
