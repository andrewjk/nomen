import BaseNode from "./BaseNode";

export default class AccessFieldNode extends BaseNode {
  name: string;
  type: string;

  constructor(start: number, name: string, type?: string) {
    super("ac_field", start);
    this.name = name;
    this.type = type || "";
  }
}
