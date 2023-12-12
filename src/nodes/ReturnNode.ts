import BaseNode from "./BaseNode";

export default class ReturnNode extends BaseNode {
  value: BaseNode;
  type: string;

  constructor(start: number, value: BaseNode, type?: string) {
    super("return", start);
    this.value = value;
    this.type = type || "";
  }
}
