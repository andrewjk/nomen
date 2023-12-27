import BaseNode from "./BaseNode";
import Type from "./Type";

export default class AccessFieldNode extends BaseNode {
  name: string;
  type: Type;

  constructor(start: number, name: string, type?: string | Type) {
    super("ac_field", start);
    this.name = name;
    this.type = typeof type === "string" ? new Type(type) : type || new Type("");
  }
}
